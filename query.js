// ============================================================================
// query.js — 100% Local RAG Query Pipeline
// ============================================================================
// Retrieval:   ChromaDB cosine similarity search (local)
// Embeddings:  Ollama nomic-embed-text (local)
// Generation:  Ollama Llama 3.1:8b (local)
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
const CHAT_MODEL = "llama3.1:8b";
const RETRIEVAL_COUNT = 20;          // Expanded: wider initial net feeds the hybrid re-ranker more candidates
const TOP_N_CHUNKS = 5;              // Keep top 5 highest-similarity chunks — enough for a dense RAG paper
const OLLAMA_CONTEXT_WINDOW = 8192;

// ---------------------------------------------------------------------------
// Advanced RAG: Cosine Similarity Threshold
// ---------------------------------------------------------------------------
// Raised to 0.40 — high enough to block off-topic noise, but permissive
// enough not to accidentally discard all chunks when PDF noise is present.
// If the LLM still sees 0 context chunks, it returns SAFE_UNKNOWN_ANSWER.
const SIMILARITY_THRESHOLD = 0.40;

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
 *
 * [ADVANCED RAG — Objective 4] Before rendering, re-sort chunks by their
 * original document position (chunkNumber for standard, parentNumber for
 * hierarchical). LLMs perform better when context is presented in
 * chronological/document order rather than similarity-ranked order.
 */
function buildContext(chunks) {
    // [ADVANCED RAG — Obj 4] Re-sort by document order so the LLM receives
    // context in the same sequence it appeared in the source document.
    const documentOrdered = [...chunks].sort((a, b) => {
        // Use parentNumber for hierarchical chunks, chunkNumber for standard
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

/**
 * Build the full prompt, engineered for Llama 3.1:8b operating over
 * the "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" paper.
 *
 * Anti-hallucination design:
 *  - Names the document explicitly so the model knows its exact scope
 *  - FORBIDS use of any knowledge not in the CONTEXT blocks
 *  - Instructs verbatim-or-close quoting rather than paraphrasing from memory
 *  - Provides a hard refusal string for anything not found in CONTEXT
 *  - Requires source citation after every answer
 *  - Uses unambiguous delimiters (=== lines) to prevent prompt injection
 *
 * @param {string} question - The user's question.
 * @param {Object[]} chunks - Context chunks to include.
 * @returns {string} - Complete prompt string.
 */
function buildPrompt(question, chunks) {
    return `[INST] <<SYS>>
You are a thorough, document-bound Q&A assistant. The ONLY document you have access to is the academic paper:
"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (Lewis et al., 2021).

The CONTEXT below contains exact excerpts from that paper. Your entire answer MUST come from these excerpts.

RULES:
1. NEVER use knowledge from your training data. ONLY answer using the CONTEXT excerpts below.
2. If the question cannot be answered from the CONTEXT, output this exact sentence and nothing else:
   "${SAFE_UNKNOWN_ANSWER}"
3. Do NOT invent names, numbers, model names, results, or claims not explicitly written in the CONTEXT.
4. Provide a DETAILED and COMPREHENSIVE answer. Cover every relevant aspect you can find in the CONTEXT.
5. Write in flowing paragraphs. Use bullet points only when listing distinct items.
6. After EACH claim or piece of information, cite the source inline like this: (Source 1) or (Source 2, Source 3).
   Do NOT put all citations at the end — cite inline after every statement.
7. Synthesize information from multiple context blocks when they discuss the same topic.
<</SYS>>

=== CONTEXT EXCERPTS FROM THE PAPER ===
${buildContext(chunks)}
=== END CONTEXT ===

Question: ${question}

Provide a detailed answer based solely on the context above: [/INST]`;
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

    // Step 2: [ADVANCED RAG — Objective 2] Apply cosine similarity threshold gate
    // IMMEDIATELY after retrieval. Any hit below SIMILARITY_THRESHOLD is discarded
    // right here before it can pollute ranking, parent expansion, or the LLM prompt.
    const filteredHits = applySimilarityGate(rawHits);

    // Step 3: [ADVANCED RAG — Objective 3] Hybrid Re-Ranking
    // Pure cosine similarity can be fooled by bibliography entries that share
    // academic vocabulary with the query. We blend cosine similarity with a
    // lightweight native JS keyword density score to promote chunks that are
    // both semantically AND lexically relevant to the user's question.
    //
    // Scoring formula:
    //   hybridScore = (cosineSimilarity × 0.7) + (keywordMatchRatio × 0.3)
    //
    // - cosineSimilarity ∈ [0, 1]: from ChromaDB's cosine distance
    // - keywordMatchRatio ∈ [0, 1]: fraction of query tokens found in the chunk
    // - Weights: 70% semantic (embedding), 30% lexical (keyword overlap)
    //   This keeps embeddings dominant while giving a meaningful boost to chunks
    //   that contain the user's actual terms.
    // -----------------------------------------------------------------------

    // Tokenize the question: lowercase, strip punctuation, keep words > 3 chars
    // to filter out stopwords and noise ("what", "is", "the", "a", etc.)
    const queryTokens = question
        .toLowerCase()
        .replace(/[^\w\s]/g, "")       // strip all punctuation
        .split(/\s+/)                   // split on whitespace
        .filter(token => token.length > 3);  // discard short/stop-ish words

    const rankedHits = [...filteredHits]
        .map(hit => {
            const chunkLower = hit.text.toLowerCase();

            // Count how many unique query tokens appear anywhere in this chunk
            const matchCount = queryTokens.filter(token => chunkLower.includes(token)).length;

            // matchRatio: fraction of query tokens found (0 = none, 1 = all)
            const matchRatio = queryTokens.length > 0
                ? matchCount / queryTokens.length
                : 0;

            // Blend: 70% cosine similarity + 30% keyword match ratio
            const hybridScore = (hit.similarity * 0.7) + (matchRatio * 0.3);

            return { ...hit, matchRatio, hybridScore };
        })
        .sort((a, b) => b.hybridScore - a.hybridScore)  // highest hybrid score first
        .slice(0, TOP_N_CHUNKS);                         // keep only top N

    console.log(
        `[Hybrid Re-Rank] ${filteredHits.length} filtered hits → top ${rankedHits.length} ` +
        `(threshold=${SIMILARITY_THRESHOLD}, topN=${TOP_N_CHUNKS}, queryTokens=${queryTokens.length})`
    );
    rankedHits.forEach((h, i) => {
        console.log(
            `  ${i + 1}. sim=${h.similarity.toFixed(4)} keyword=${h.matchRatio.toFixed(2)} ` +
            `hybrid=${h.hybridScore.toFixed(4)} preview="${h.text.replace(/\s+/g, " ").slice(0, 80)}"`
        );
    });

    // Step 4: Expand to parent context (hierarchical) or dedupe (standard)
    const contextChunks = buildContextChunks(rankedHits, chunkingMethod);

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
                    temperature: 0.0,    // Fully deterministic — no sampling randomness
                    top_p: 0.9,          // Wider token pool allows longer, more natural prose
                    repeat_penalty: 1.1,  // Lighter penalty — avoids cutting off detailed answers
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
