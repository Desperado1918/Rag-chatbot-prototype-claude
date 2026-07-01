// ============================================================================
// services/generation.js — LLM Prompt Building & Streaming
// ============================================================================
// Extracted from query.js. Handles:
//   1. Context formatting for LLM prompt
//   2. System prompt construction (anti-hallucination design)
//   3. Ollama streaming inference
// ============================================================================

const axios = require("axios");
const config = require("../config");
const { createServiceError } = require("../utils/errors");

// ---------------------------------------------------------------------------
// Context Formatting
// ---------------------------------------------------------------------------

/**
 * Format context chunks into a labeled, delimited context string.
 * Re-sorts by document order so the LLM receives context in the same
 * sequence it appeared in the source document.
 */
function buildContext(chunks) {
    const documentOrdered = [...chunks].sort((a, b) => {
        const posA =
            a.metadata.parentNumber ?? a.metadata.chunkNumber ?? Infinity;
        const posB =
            b.metadata.parentNumber ?? b.metadata.chunkNumber ?? Infinity;
        return posA - posB;
    });

    return documentOrdered
        .map((chunk, index) => {
            const source = chunk.metadata.source || "unknown";
            const label =
                chunk.metadata.chunkingMethod === "hierarchical"
                    ? `parent ${chunk.metadata.parentNumber}`
                    : `chunk ${chunk.metadata.chunkNumber}`;

            return `[Source ${index + 1}: ${source}, ${label}, similarity ${chunk.similarity}]\n${chunk.text}`;
        })
        .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Prompt Engineering
// ---------------------------------------------------------------------------

/**
 * Build the full prompt for the LLM. Engineered for strict document-bound
 * reading comprehension with anti-hallucination safeguards.
 *
 * @param {string} question - The user's question.
 * @param {Object[]} chunks - Context chunks to include.
 * @param {Object} [options] - Additional options.
 * @param {string} [options.conversationContext] - Previous conversation summary for memory.
 * @returns {string} - Complete prompt string.
 */
function buildPrompt(question, chunks, options = {}) {
    let conversationSection = "";
    if (options.conversationContext) {
        conversationSection = `
=== PREVIOUS CONVERSATION CONTEXT ===
${options.conversationContext}
=== END PREVIOUS CONTEXT ===

`;
    }

    return `[INST] <<SYS>>
You are a thorough, document-bound Q&A assistant. The ONLY document you have access to is the academic paper:
"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (Lewis et al., 2021).

The CONTEXT below contains exact excerpts from that paper. Your entire answer MUST come from these excerpts.

RULES:
1. NEVER use knowledge from your training data. ONLY answer using the CONTEXT excerpts below.
2. If the question cannot be answered from the CONTEXT, output this exact sentence and nothing else:
   "${config.safeUnknownAnswer}"
3. Do NOT invent names, numbers, model names, results, or claims not explicitly written in the CONTEXT.
4. Provide a DETAILED and COMPREHENSIVE answer. Cover every relevant aspect you can find in the CONTEXT.
5. Write in flowing paragraphs. Use bullet points only when listing distinct items.
6. After EACH claim or piece of information, cite the source inline like this: (Source 1) or (Source 2, Source 3).
   Do NOT put all citations at the end — cite inline after every statement.
7. Synthesize information from multiple context blocks when they discuss the same topic.
<</SYS>>

${conversationSection}=== CONTEXT EXCERPTS FROM THE PAPER ===
${buildContext(chunks)}
=== END CONTEXT ===

Question: ${question}

Provide a detailed answer based solely on the context above: [/INST]`;
}

// ---------------------------------------------------------------------------
// LLM Streaming: Ollama local inference
// ---------------------------------------------------------------------------

/**
 * Stream an answer from Ollama's local LLM.
 * Uses Server-Sent Events (SSE) style streaming for real-time token delivery.
 *
 * @param {string} prompt - The complete prompt string.
 * @param {Object} handlers - { onToken, onDone } callback handlers.
 */
async function streamOllamaAnswer(prompt, handlers = {}) {
    let bufferedLine = "";
    let isFinished = false;

    function finish(resolve) {
        if (isFinished) {
            return;
        }

        isFinished = true;
        handlers.onDone?.();
        resolve();
    }

    try {
        const response = await axios.post(
            `${config.ollama.baseUrl}/api/generate`,
            {
                model: config.ollama.chatModel,
                prompt,
                stream: true,
                options: {
                    temperature: config.generation.temperature,
                    top_p: config.generation.topP,
                    repeat_penalty: config.generation.repeatPenalty,
                    num_ctx: config.ollama.contextWindow,
                },
            },
            {
                responseType: "stream",
            }
        );

        return new Promise((resolve, reject) => {
            response.data.on("data", (chunk) => {
                bufferedLine += chunk.toString();
                const lines = bufferedLine.split("\n");
                bufferedLine = lines.pop() || "";

                for (const line of lines) {
                    if (!line.trim()) {
                        continue;
                    }

                    try {
                        const payload = JSON.parse(line);

                        if (payload.response) {
                            handlers.onToken?.(payload.response);
                        }

                        if (payload.done) {
                            finish(resolve);
                        }
                    } catch (error) {
                        reject(error);
                    }
                }
            });

            response.data.on("end", () => {
                if (bufferedLine.trim()) {
                    try {
                        const payload = JSON.parse(bufferedLine);

                        if (payload.response) {
                            handlers.onToken?.(payload.response);
                        }
                    } catch (error) {
                        reject(error);
                        return;
                    }
                }

                finish(resolve);
            });

            response.data.on("error", reject);
        });
    } catch (error) {
        throw createServiceError(
            `Ollama chat model is not responding. Make sure the ${config.ollama.chatModel} model is installed.`
        );
    }
}

module.exports = {
    buildContext,
    buildPrompt,
    streamOllamaAnswer,
};
