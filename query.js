// ============================================================================
// query.js — 100% Local RAG Query Pipeline
// ============================================================================
// Retrieval:   ChromaDB cosine similarity search (local)
// Embeddings:  Ollama nomic-embed-text (local)
// Generation:  Ollama Llama 3.2:3b (local)
// Prompting:   Strict context-bound reading comprehension — NO hallucination
// ============================================================================

const axios = require("axios");
const { ChromaClient } = require("chromadb");
const { getCollectionName, normalizeChunkingMethod } = require("./ingest");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_URL = "http://127.0.0.1:11434";
const CHROMA_URL = "http://localhost:8000";
const EMBEDDING_MODEL = "nomic-embed-text";
const CHAT_MODEL = "llama3.2:3b";
const RETRIEVAL_COUNT = 4;
const OLLAMA_CONTEXT_WINDOW = 8192;

// ---------------------------------------------------------------------------
// REQUIREMENT 4: Cosine Similarity Threshold
// ---------------------------------------------------------------------------
// With cosine distance configured in ChromaDB, distances range from 0 (identical)
// to 2 (opposite). We convert to similarity via: similarity = 1 - distance.
// A threshold of 0.30 means we reject any hit with less than 30% cosine
// similarity, filtering out irrelevant noise before it reaches the LLM.
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.30;

// The exact refusal string the model should output when context is insufficient
const SAFE_UNKNOWN_ANSWER = "I don't know based on the provided documents.";

// ---------------------------------------------------------------------------
// Error Utility
// ---------------------------------------------------------------------------

function createServiceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

// ---------------------------------------------------------------------------
// Text Normalization (for deduplication comparisons)
// ---------------------------------------------------------------------------

function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// REQUIREMENT 4: Cosine Distance → Cosine Similarity Conversion
// ---------------------------------------------------------------------------
// ChromaDB cosine distance ∈ [0, 2]:
//   - 0.0 = perfectly similar (vectors point same direction)
//   - 1.0 = orthogonal (no relationship)
//   - 2.0 = perfectly opposite
//
// Similarity = 1 - distance:
//   - 1.0 = perfect match
//   - 0.0 = no relationship
//   - -1.0 = opposite
//
// For normalized embeddings (like nomic-embed-text), values typically
// cluster in [0.5, 1.0] for relevant hits and [0.0, 0.3] for noise.
// ---------------------------------------------------------------------------

function distanceToSimilarity(distance) {
    if (typeof distance !== "number") {
        return null;
    }

    // Cosine distance to cosine similarity: simply subtract from 1
    return Number((1 - distance).toFixed(4));
}

// ---------------------------------------------------------------------------
// Embedding: Generate query embedding locally via Ollama
// ---------------------------------------------------------------------------

async function createEmbedding(text) {
    try {
        const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
            model: EMBEDDING_MODEL,
            prompt: text
        });

        return response.data.embedding;
    } catch (error) {
        throw createServiceError(
            `Ollama embedding model is not responding. Make sure Ollama is running and the ${EMBEDDING_MODEL} model is installed.`
        );
    }
}

// ---------------------------------------------------------------------------
// ChromaDB Collection Access
// ---------------------------------------------------------------------------

async function getCollection(chunkingMethod) {
    const client = new ChromaClient({ path: CHROMA_URL });
    const collectionName = getCollectionName(chunkingMethod);

    try {
        return await client.getCollection({ name: collectionName });
    } catch (error) {
        throw createServiceError(
            `Chroma collection "${collectionName}" was not found. Run ingestion for the ${chunkingMethod} chunking method first.`
        );
    }
}

// ---------------------------------------------------------------------------
// Vector Retrieval: Query ChromaDB and format results
// ---------------------------------------------------------------------------

/**
 * Format raw ChromaDB query results into a consistent array of hit objects.
 * Each hit includes the document text, metadata, raw distance, and computed
 * cosine similarity score.
 */
function formatResults(results) {
    const documents = results.documents?.[0] || [];
    const metadatas = results.metadatas?.[0] || [];
    const distances = results.distances?.[0] || [];

    return documents.map((document, index) => ({
        text: document,
        metadata: metadatas[index] || {},
        distance: distances[index],
        similarity: distanceToSimilarity(distances[index])
    }));
}

/**
 * Retrieve the top-K most similar vector hits from ChromaDB for a given question.
 * Returns raw hits with distances and computed similarity scores.
 *
 * @param {string} question - The user's question.
 * @param {string} chunkingMethod - "standard" or "hierarchical".
 * @returns {Promise<Object[]>} - Array of hit objects.
 */
async function retrieveVectorHits(question, chunkingMethod) {
    const queryEmbedding = await createEmbedding(question);
    const collection = await getCollection(chunkingMethod);

    try {
        const results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: RETRIEVAL_COUNT,
            include: ["documents", "metadatas", "distances"]
        });

        console.log("RAW DISTANCES:");
        console.dir(results.distances, { depth: null });

        return formatResults(results);
    } catch (error) {
        throw createServiceError(
            "Chroma query failed. Make sure the Chroma server is running on http://localhost:8000."
        );
    }
}

// ---------------------------------------------------------------------------
// REQUIREMENT 4: Similarity Gate — Filter out low-confidence hits
// ---------------------------------------------------------------------------
// Hits below the SIMILARITY_THRESHOLD are discarded before prompt construction.
// This prevents irrelevant context from reaching Llama 3.2, which reduces
// hallucination risk and keeps the context window focused.
// ---------------------------------------------------------------------------

function applySimilarityGate(hits) {
    return hits.filter(
        (hit) => typeof hit.similarity === "number" && hit.similarity >= SIMILARITY_THRESHOLD
    );
}

// ---------------------------------------------------------------------------
// Deduplication Utilities
// ---------------------------------------------------------------------------

/**
 * Deduplicate chunks by their text content (normalized).
 * Used for the standard chunking method to avoid sending duplicate
 * context to the LLM.
 */
function dedupeByText(chunks) {
    const seen = new Set();
    const uniqueChunks = [];

    for (const chunk of chunks) {
        const key = normalizeText(chunk.text);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        uniqueChunks.push(chunk);
    }

    return uniqueChunks;
}

// ---------------------------------------------------------------------------
// REQUIREMENT 4: Hierarchical Parent Expansion and Deduplication
// ---------------------------------------------------------------------------
// When using hierarchical chunking, ChromaDB returns child chunk hits.
// Multiple children may belong to the same parent. This function:
//   1. Extracts the parentText from each child's metadata
//   2. Deduplicates by parentId (so each parent is sent to the LLM only once)
//   3. Preserves the highest-similarity child's score for the parent
//
// This saves LLM context space and provides richer context than individual
// child chunks alone.
// ---------------------------------------------------------------------------

/**
 * Expand child hits into their deduplicated parent texts.
 * Returns an array of parent-level context chunks with metadata.
 *
 * @param {Object[]} childHits - Array of child hit objects that passed the similarity gate.
 * @returns {Object[]} - Array of parent context chunks, deduplicated by parentId.
 */
function expandHierarchicalParents(childHits) {
    const parentMap = new Map();

    for (const childHit of childHits) {
        const parentId = childHit.metadata.parentId;
        const parentText = childHit.metadata.parentText;

        // Skip if no parent linkage exists, or if we already have this parent
        // (keep the first occurrence, which has the highest similarity since
        // hits are sorted by distance)
        if (!parentId || !parentText || parentMap.has(parentId)) {
            continue;
        }

        parentMap.set(parentId, {
            text: parentText,
            similarity: childHit.similarity,
            metadata: {
                source: childHit.metadata.source,
                parentId,
                parentNumber: childHit.metadata.parentNumber,
                matchedChildNumber: childHit.metadata.childNumber,
                chunkingMethod: "hierarchical"
            }
        });
    }

    // Log deduplication statistics for debugging and benchmarking
    const childCount = childHits.length;
    const parentCount = parentMap.size;
    console.log(
        `[Hierarchical Dedup] ${childCount} child hits → ${parentCount} unique parents ` +
        `(${childCount > 0 ? ((1 - parentCount / childCount) * 100).toFixed(1) : 0}% dedup rate)`
    );

    return Array.from(parentMap.values());
}

/**
 * Build the context chunks to send to the LLM based on the chunking method.
 * For hierarchical: expands children to deduplicated parents.
 * For standard: deduplicates by text content.
 *
 * @param {Object[]} hits - Similarity-gated hits.
 * @param {string} chunkingMethod - "standard" or "hierarchical".
 * @returns {Object[]} - Context chunks for the LLM.
 */
function buildContextChunks(hits, chunkingMethod) {
    if (chunkingMethod === "hierarchical") {
        return expandHierarchicalParents(hits);
    }

    return dedupeByText(
        hits.map((hit) => ({
            text: hit.text,
            similarity: hit.similarity,
            metadata: hit.metadata
        }))
    );
}

// ---------------------------------------------------------------------------
// Logging: Retrieval diagnostics
// ---------------------------------------------------------------------------

function logRetrievedChunks(rawHits, filteredHits, contextChunks, chunkingMethod) {
    console.log("\nRetrieved vector hits:");

    rawHits.forEach((hit, index) => {
        const source = hit.metadata.source || "unknown";
        const parent = hit.metadata.parentId || "none";
        const chunk = hit.metadata.chunkNumber || hit.metadata.childNumber || "unknown";
        const preview = hit.text.replace(/\s+/g, " ").slice(0, 140);

        console.log(
            `${index + 1}. source=${source}, chunk=${chunk}, parent=${parent}, ` +
            `dist=${hit.distance?.toFixed(4)}, sim=${hit.similarity}, preview="${preview}"`
        );
    });

    console.log(
        `Similarity gate: ${filteredHits.length}/${rawHits.length} hits passed >= ${SIMILARITY_THRESHOLD}`
    );
    console.log(`Context chunks sent to LLM (${chunkingMethod}): ${contextChunks.length}`);
}

// ============================================================================
// REQUIREMENT 1: Strict Context-Bound System Prompt for Llama 3.2
// ============================================================================
// This prompt is specifically engineered for Llama 3.2:3b to enforce strict
// reading comprehension behavior. Key design decisions:
//
// 1. EXPLICIT ROLE: "reading comprehension assistant" — frames the task clearly
// 2. HARD PROHIBITION: "absolutely forbidden from using outside knowledge"
// 3. EXACT REFUSAL: Specifies the exact string to output when context is lacking
// 4. CITATION GUIDANCE: Tells the model to reference specific context sections
// 5. CLEAR DELIMITERS: ### headers separate system/context/question to avoid
//    prompt injection or boundary confusion in smaller models
// ============================================================================

/**
 * Format context chunks into a labeled, delimited context string.
 * Each chunk gets a numbered label with its source and similarity score.
 */
function buildContext(chunks) {
    return chunks
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

/**
 * Build the full prompt with strict reading comprehension instructions.
 * Uses clear section delimiters to prevent prompt confusion in Llama 3.2.
 *
 * @param {string} question - The user's question.
 * @param {Object[]} chunks - Context chunks to include.
 * @returns {string} - Complete prompt string.
 */
function buildPrompt(question, chunks) {
    return `### SYSTEM INSTRUCTIONS
You are a strict reading comprehension assistant. Your ONLY job is to answer questions by analyzing the CONTEXT passages provided below.

RULES YOU MUST FOLLOW:
1. You are absolutely FORBIDDEN from using any outside knowledge, training data, or general knowledge to answer questions.
2. You may ONLY use information that is EXPLICITLY stated in the CONTEXT sections below.
3. If the answer to the question is NOT found in the CONTEXT, you MUST respond with EXACTLY this phrase and nothing else: "${SAFE_UNKNOWN_ANSWER}"
4. Do NOT speculate, infer beyond what is written, or synthesize information from outside the provided CONTEXT.
5. When answering, reference which Context Source(s) support your answer.
6. Keep your answers precise and grounded in the exact wording of the CONTEXT.

### CONTEXT
${buildContext(chunks)}

### QUESTION
${question}

### ANSWER`;
}

/**
 * Build source metadata for the API response.
 */
function buildSources(chunks) {
    return chunks.map((chunk) => ({
        source: chunk.metadata.source || "unknown",
        chunkingMethod: chunk.metadata.chunkingMethod || "standard",
        chunkNumber: chunk.metadata.chunkNumber || null,
        parentId: chunk.metadata.parentId || null,
        parentNumber: chunk.metadata.parentNumber || null,
        matchedChildNumber: chunk.metadata.matchedChildNumber || null,
        similarity: chunk.similarity,
        text: chunk.text
    }));
}

// ---------------------------------------------------------------------------
// Answer Preparation: Retrieval → Gate → Context → Prompt
// ---------------------------------------------------------------------------

/**
 * Prepare everything needed to answer a question: retrieve vectors, apply
 * the similarity gate, expand hierarchical parents, and build the prompt.
 * Does NOT call the LLM — that's handled by the streaming/non-streaming callers.
 *
 * @param {string} question - The user's question.
 * @param {Object} options - { chunkingMethod: "standard" | "hierarchical" }
 * @returns {Promise<Object>} - Prepared answer object.
 */
async function prepareAnswer(question, options = {}) {
    if (!question || !question.trim()) {
        throw createServiceError("Question is required", 400);
    }

    const chunkingMethod = normalizeChunkingMethod(options.chunkingMethod);

    // Step 1: Retrieve top-K vector hits from ChromaDB
    const rawHits = await retrieveVectorHits(question, chunkingMethod);

    // Step 2: Apply cosine similarity threshold gate
    const filteredHits = applySimilarityGate(rawHits);

    // Step 3: Expand to parent context (hierarchical) or dedupe (standard)
    const contextChunks = buildContextChunks(filteredHits, chunkingMethod);

    // Log retrieval diagnostics
    logRetrievedChunks(rawHits, filteredHits, contextChunks, chunkingMethod);

    // Step 4: If no context passes the gate, return the safe refusal immediately
    if (contextChunks.length === 0) {
        return {
            shouldGenerate: false,
            answer: SAFE_UNKNOWN_ANSWER,
            sources: [],
            chunkingMethod
        };
    }

    // Step 5: Build the strict reading comprehension prompt
    return {
        shouldGenerate: true,
        prompt: buildPrompt(question, contextChunks),
        sources: buildSources(contextChunks),
        chunkingMethod
    };
}

// ---------------------------------------------------------------------------
// LLM Streaming: Ollama local inference
// ---------------------------------------------------------------------------

/**
 * Stream an answer from Ollama's local Llama 3.2 model.
 * Uses Server-Sent Events (SSE) style streaming for real-time token delivery.
 * Temperature is set to 0.0 for deterministic, factual responses.
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
            `${OLLAMA_URL}/api/generate`,
            {
                model: CHAT_MODEL,
                prompt,
                stream: true,
                options: {
                    temperature: 0.0,
                    num_ctx: OLLAMA_CONTEXT_WINDOW
                }
            },
            {
                responseType: "stream"
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
            `Ollama chat model is not responding. Make sure the ${CHAT_MODEL} model is installed.`
        );
    }
}

// ---------------------------------------------------------------------------
// Public API: Streaming and non-streaming question answering
// ---------------------------------------------------------------------------

/**
 * Ask a question with streaming token delivery.
 * Used by the SSE endpoint in server.js.
 */
async function askQuestionStream(question, options = {}, handlers = {}) {
    const prepared = await prepareAnswer(question, options);

    handlers.onSources?.(prepared.sources, prepared.chunkingMethod);

    if (!prepared.shouldGenerate) {
        handlers.onToken?.(prepared.answer);
        handlers.onDone?.();
        return prepared;
    }

    await streamOllamaAnswer(prepared.prompt, handlers);

    return prepared;
}

/**
 * Ask a question and return the complete answer as a string.
 * Used by the JSON endpoint in server.js and by benchmark.js.
 */
async function askQuestion(question, options = {}) {
    let answer = "";
    const prepared = await askQuestionStream(question, options, {
        onToken: (token) => {
            answer += token;
        }
    });

    return {
        answer: answer || prepared.answer,
        sources: prepared.sources,
        chunkingMethod: prepared.chunkingMethod
    };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
    const question = process.argv.slice(2).join(" ") || "What is RAG?";
    const result = await askQuestion(question, { chunkingMethod: "hierarchical" });

    console.log("\nANSWER:\n");
    console.log(result.answer);
    console.log("\nSOURCES:\n");
    console.log(result.sources);
}

if (require.main === module) {
    main().catch(console.error);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    SAFE_UNKNOWN_ANSWER,
    SIMILARITY_THRESHOLD,
    askQuestion,
    askQuestionStream,
    buildPrompt,
    prepareAnswer,
    // Export for benchmark access
    retrieveVectorHits,
    applySimilarityGate,
    expandHierarchicalParents,
    distanceToSimilarity
};
