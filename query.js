// ============================================================================
// query.js — Hybrid RAG Pipeline: PageIndex Retrieval + Ollama Generation
// ============================================================================
// Two-stage pipeline:
//   1. RETRIEVAL: PageIndex navigates the document's tree index to find
//      relevant sections (headings, paragraphs, tables, figures).
//   2. GENERATION: Ollama (Qwen 2.5 7B) generates a grounded answer using
//      ONLY the retrieved context — zero hallucination, zero outside knowledge.
//
// This ensures answers come strictly from the uploaded documents.
// ============================================================================

require("dotenv").config();

const axios = require("axios");
const { getDocId, getClient } = require("./ingest");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

// The exact refusal string when no relevant context is found
const SAFE_UNKNOWN_ANSWER = "I don't know based on the provided documents.";

// ---------------------------------------------------------------------------
// System Prompt — Strict Document Grounding
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a precise research assistant. Your ONLY job is to answer questions based on the CONTEXT provided below.

STRICT RULES:
1. Answer ONLY using information from the provided CONTEXT sections.
2. If the answer is NOT in the context, say exactly: "I don't know based on the provided documents."
3. NEVER make up information, speculate, or use outside knowledge.
4. When referencing information, mention which section or page it comes from if available.
5. Be detailed and comprehensive — extract all relevant information from the context.
6. Use clear formatting: bullet points for lists, bold for key terms.
7. If the context contains tables, figures, or equations, describe them accurately.

You are forbidden from:
- Guessing or inferring beyond what is explicitly stated
- Using any training knowledge that is not in the provided context
- Making up citations, references, or data points`;

// ---------------------------------------------------------------------------
// Error Utility
// ---------------------------------------------------------------------------

function createServiceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

// ---------------------------------------------------------------------------
// Stage 1: PageIndex Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve relevant document sections from PageIndex.
 * Uses the Chat API in non-streaming mode to get the tree-navigated content,
 * then extracts the sources/context for local generation.
 *
 * @param {string} question - The user's question.
 * @returns {Promise<Object>} - { context, sources }
 */
async function retrieveFromPageIndex(question) {
    const docId = getDocId();

    if (!docId) {
        throw createServiceError(
            "No document has been ingested yet. Please upload a document first.",
            400
        );
    }

    const client = getClient();

    try {
        console.log(`\n[PageIndex Retrieval] "${question}"`);
        console.log(`[PageIndex Retrieval] doc_id: ${docId}`);

        // Use PageIndex Chat API to get context-enriched response
        // The API internally navigates the tree to find relevant sections
        const stream = await client.api.chatCompletions({
            messages: [
                {
                    role: "user",
                    content: question
                }
            ],
            doc_id: docId,
            stream: true
        });

        let retrievedContext = "";
        let sources = [];

        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
                retrievedContext += content;
            }

            // Collect source references
            if (chunk.sources || chunk.references) {
                const newSources = (chunk.sources || chunk.references || []).map((src) => ({
                    source: src.title || src.page || "Document",
                    page: src.page || null,
                    node: src.node_id || src.node || null,
                    text: src.text || src.content || ""
                }));
                sources.push(...newSources);
            }
        }

        // Deduplicate sources
        const uniqueSources = [];
        const seen = new Set();
        for (const src of sources) {
            const key = `${src.source}-${src.page}-${src.node}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueSources.push(src);
            }
        }

        console.log(`[PageIndex Retrieval] Retrieved ${retrievedContext.length} chars of context`);
        console.log(`[PageIndex Retrieval] ${uniqueSources.length} unique sources found`);

        return {
            context: retrievedContext,
            sources: uniqueSources
        };
    } catch (error) {
        console.error("[PageIndex Retrieval] Error:", error.message);

        if (error.response?.status === 404) {
            throw createServiceError(
                "Document not found on PageIndex. Please re-ingest the document.",
                404
            );
        }

        if (error.response?.status === 429) {
            throw createServiceError(
                "PageIndex rate limit exceeded. Please wait a moment and try again.",
                429
            );
        }

        throw createServiceError(
            error.message || "PageIndex retrieval failed. Check your API key and connection."
        );
    }
}

// ---------------------------------------------------------------------------
// Stage 2: Ollama Generation (Qwen 2.5 7B)
// ---------------------------------------------------------------------------

/**
 * Generate a grounded answer using Ollama with Qwen 2.5 7B.
 * Streams tokens back in real-time via callback.
 *
 * @param {string} question - The user's question.
 * @param {string} context - Retrieved document context from PageIndex.
 * @param {Function} onToken - Callback for each streamed token.
 * @returns {Promise<string>} - The complete generated answer.
 */
async function generateWithOllama(question, context, onToken) {
    const userPrompt = `CONTEXT FROM DOCUMENT:
---
${context}
---

QUESTION: ${question}

Provide a detailed, accurate answer based ONLY on the context above. If the context does not contain enough information to answer, say "I don't know based on the provided documents."`;

    try {
        console.log(`[Ollama Generation] Model: ${OLLAMA_MODEL}`);
        console.log(`[Ollama Generation] Context length: ${context.length} chars`);

        const response = await axios({
            method: "post",
            url: `${OLLAMA_BASE_URL}/api/chat`,
            data: {
                model: OLLAMA_MODEL,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userPrompt }
                ],
                stream: true,
                options: {
                    temperature: 0.1,      // Low temperature for factual answers
                    top_p: 0.9,
                    num_predict: 2048,     // Allow long, detailed answers
                    repeat_penalty: 1.1
                }
            },
            responseType: "stream",
            timeout: 120000 // 2 minute timeout for generation
        });

        let fullAnswer = "";

        return new Promise((resolve, reject) => {
            let buffer = "";

            response.data.on("data", (chunk) => {
                buffer += chunk.toString();

                // Ollama streams newline-delimited JSON
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const parsed = JSON.parse(line);

                        if (parsed.message?.content) {
                            fullAnswer += parsed.message.content;
                            onToken?.(parsed.message.content);
                        }

                        if (parsed.done) {
                            console.log(`[Ollama Generation] Complete — ${fullAnswer.length} chars`);
                            resolve(fullAnswer);
                        }
                    } catch (parseError) {
                        // Ignore partial JSON lines
                    }
                }
            });

            response.data.on("error", (err) => {
                reject(createServiceError(`Ollama stream error: ${err.message}`));
            });

            response.data.on("end", () => {
                // Handle remaining buffer
                if (buffer.trim()) {
                    try {
                        const parsed = JSON.parse(buffer);
                        if (parsed.message?.content) {
                            fullAnswer += parsed.message.content;
                            onToken?.(parsed.message.content);
                        }
                    } catch {
                        // Ignore
                    }
                }
                resolve(fullAnswer);
            });
        });
    } catch (error) {
        if (error.code === "ECONNREFUSED") {
            throw createServiceError(
                `Cannot connect to Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running (ollama serve).`,
                503
            );
        }

        if (error.response?.status === 404) {
            throw createServiceError(
                `Model "${OLLAMA_MODEL}" not found. Pull it with: ollama pull ${OLLAMA_MODEL}`,
                404
            );
        }

        throw createServiceError(
            error.message || "Ollama generation failed. Check that Ollama is running."
        );
    }
}

// ---------------------------------------------------------------------------
// Combined Pipeline — Streaming
// ---------------------------------------------------------------------------

/**
 * Full RAG pipeline: PageIndex retrieval → Ollama generation.
 * Streams tokens back in real-time via callback handlers.
 *
 * @param {string} question - The user's question.
 * @param {Object} handlers - { onToken, onSources, onDone } callbacks.
 * @returns {Promise<void>}
 */
async function askQuestionStream(question, handlers = {}) {
    if (!question || !question.trim()) {
        throw createServiceError("Question is required", 400);
    }

    // Stage 1: Retrieve relevant sections from PageIndex
    const { context, sources } = await retrieveFromPageIndex(question);

    // Send sources to the frontend immediately
    if (sources.length > 0) {
        handlers.onSources?.(sources);
    }

    // If no context was retrieved, return a safe answer
    if (!context || context.trim().length === 0) {
        handlers.onToken?.(SAFE_UNKNOWN_ANSWER);
        handlers.onDone?.();
        return;
    }

    // Stage 2: Generate grounded answer using Ollama/Qwen
    await generateWithOllama(question, context, (token) => {
        handlers.onToken?.(token);
    });

    handlers.onDone?.();
}

/**
 * Ask a question and return the complete answer as a string.
 * Non-streaming version for simple API usage.
 *
 * @param {string} question - The user's question.
 * @returns {Promise<Object>} - { answer, sources }
 */
async function askQuestion(question) {
    let answer = "";
    let sources = [];

    await askQuestionStream(question, {
        onToken: (token) => {
            answer += token;
        },
        onSources: (s) => {
            sources = s;
        }
    });

    return {
        answer: answer || SAFE_UNKNOWN_ANSWER,
        sources
    };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
    const question = process.argv.slice(2).join(" ") || "What is RAG?";
    console.log(`\nAsking: "${question}"\n`);

    const result = await askQuestion(question);

    console.log("\nANSWER:\n");
    console.log(result.answer);

    if (result.sources.length > 0) {
        console.log("\nSOURCES:\n");
        console.log(result.sources);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    SAFE_UNKNOWN_ANSWER,
    askQuestion,
    askQuestionStream
};
