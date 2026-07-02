// ============================================================================
// services/llmService.js — Provider-Switchable LLM Service
// ============================================================================
// Wraps LLM calls behind a provider interface. Default: Ollama via axios.
// Reads config.chatProvider to select the backend.
//
// Decision: We keep axios (not the ollama npm client) because:
//   - The streaming implementation already exists and works
//   - Full control over timeouts, headers, and retry logic
//   - No additional dependency needed
// ============================================================================

const axios = require("axios");
const config = require("../config");
const { createServiceError } = require("../utils/errors");

/**
 * Stream a chat completion from the configured LLM provider.
 *
 * @param {Object[]} messages - Array of { role, content } message objects.
 * @param {Object} [options] - Additional options.
 * @param {Object} handlers - { onToken: fn(string), onDone: fn() }
 * @returns {Promise<string>} - The full assembled response text.
 */
async function streamChat(messages, options = {}, handlers = {}) {
    const provider = options.provider || config.chatProvider;

    if (provider === "openai") {
        return streamOpenAI(messages, options, handlers);
    }

    return streamOllama(messages, options, handlers);
}

/**
 * Generate a short text completion (non-streaming).
 * Used for title generation and other quick tasks.
 *
 * @param {string} prompt - The prompt text.
 * @param {Object} [options] - LLM options.
 * @returns {Promise<string>} - The generated text.
 */
async function generateCompletion(prompt, options = {}) {
    const provider = options.provider || config.chatProvider;

    if (provider === "openai") {
        return generateOpenAICompletion(prompt, options);
    }

    return generateOllamaCompletion(prompt, options);
}

// ---------------------------------------------------------------------------
// Ollama Provider
// ---------------------------------------------------------------------------

async function streamOllama(messages, options, handlers) {
    let fullResponse = "";
    let bufferedLine = "";

    try {
        const response = await axios.post(
            `${config.ollama.baseUrl}/api/chat`,
            {
                model: options.model || config.ollama.chatModel,
                messages,
                stream: true,
                options: {
                    temperature: options.temperature ?? config.generation.temperature,
                    top_p: options.topP ?? config.generation.topP,
                    repeat_penalty: config.generation.repeatPenalty,
                    num_ctx: config.ollama.contextWindow,
                },
            },
            {
                responseType: "stream",
                timeout: 120000, // 2 minute timeout
            }
        );

        return new Promise((resolve, reject) => {
            response.data.on("data", (chunk) => {
                bufferedLine += chunk.toString();
                const lines = bufferedLine.split("\n");
                bufferedLine = lines.pop() || "";

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const payload = JSON.parse(line);

                        if (payload.message?.content) {
                            fullResponse += payload.message.content;
                            handlers.onToken?.(payload.message.content);
                        }

                        if (payload.done) {
                            handlers.onDone?.();
                            resolve(fullResponse);
                        }
                    } catch (parseErr) {
                        // Skip malformed lines
                    }
                }
            });

            response.data.on("end", () => {
                // Process any remaining buffered content
                if (bufferedLine.trim()) {
                    try {
                        const payload = JSON.parse(bufferedLine);
                        if (payload.message?.content) {
                            fullResponse += payload.message.content;
                            handlers.onToken?.(payload.message.content);
                        }
                    } catch (e) {
                        // Ignore
                    }
                }
                handlers.onDone?.();
                resolve(fullResponse);
            });

            response.data.on("error", (err) => {
                reject(err);
            });
        });
    } catch (error) {
        throw createServiceError(
            `Ollama is not responding at ${config.ollama.baseUrl}. ` +
            `Make sure Ollama is running and the "${config.ollama.chatModel}" model is installed. ` +
            `(Run: ollama pull ${config.ollama.chatModel})`
        );
    }
}

async function generateOllamaCompletion(prompt, options = {}) {
    try {
        const response = await axios.post(
            `${config.ollama.baseUrl}/api/generate`,
            {
                model: options.model || config.ollama.chatModel,
                prompt,
                stream: false,
                options: {
                    temperature: options.temperature ?? 0.3,
                    num_predict: options.maxTokens ?? 30,
                    num_ctx: 2048,
                },
            },
            { timeout: 30000 }
        );

        return (response.data.response || "").trim();
    } catch (error) {
        throw createServiceError(
            `Ollama completion failed: ${error.message}`
        );
    }
}

// ---------------------------------------------------------------------------
// OpenAI Provider (stub — only used when CHAT_PROVIDER=openai)
// ---------------------------------------------------------------------------

async function streamOpenAI(_messages, _options, _handlers) {
    throw createServiceError(
        "OpenAI provider is not yet implemented. Set CHAT_PROVIDER=ollama or implement this method."
    );
}

async function generateOpenAICompletion(_prompt, _options) {
    throw createServiceError(
        "OpenAI completion is not yet implemented. Set CHAT_PROVIDER=ollama."
    );
}

module.exports = { streamChat, generateCompletion };
