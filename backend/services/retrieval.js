// ============================================================================
// services/retrieval.js — Vector Retrieval & Hybrid Re-Ranking
// ============================================================================
// Extracted from query.js. Handles:
//   1. ChromaDB vector search
//   2. Cosine similarity gate
//   3. Hybrid re-ranking (semantic + keyword)
//   4. Hierarchical parent expansion & deduplication
// ============================================================================

const { ChromaClient } = require("chromadb");
const config = require("../config");
const { createEmbedding } = require("./embedding");
const { createServiceError } = require("../utils/errors");

// ---------------------------------------------------------------------------
// Text Normalization (for deduplication comparisons)
// ---------------------------------------------------------------------------

function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Cosine Distance → Cosine Similarity Conversion
// ---------------------------------------------------------------------------

function distanceToSimilarity(distance) {
    if (typeof distance !== "number") {
        return null;
    }
    return Number((1 - distance).toFixed(4));
}

// ---------------------------------------------------------------------------
// ChromaDB Collection Access
// ---------------------------------------------------------------------------

/**
 * Get an existing ChromaDB collection by chunking method.
 * Uses the collection naming convention from the ingestion service.
 *
 * @param {string} collectionName - Name of the collection to retrieve.
 * @returns {Promise<Object>} - ChromaDB collection handle.
 */
async function getCollection(collectionName) {
    const client = new ChromaClient({ path: config.chroma.url });

    try {
        return await client.getCollection({ name: collectionName });
    } catch (error) {
        throw createServiceError(
            `Chroma collection "${collectionName}" was not found. Run ingestion first.`
        );
    }
}

// ---------------------------------------------------------------------------
// Vector Retrieval: Query ChromaDB and format results
// ---------------------------------------------------------------------------

/**
 * Format raw ChromaDB query results into a consistent array of hit objects.
 */
function formatResults(results) {
    const documents = results.documents?.[0] || [];
    const metadatas = results.metadatas?.[0] || [];
    const distances = results.distances?.[0] || [];

    return documents.map((document, index) => ({
        text: document,
        metadata: metadatas[index] || {},
        distance: distances[index],
        similarity: distanceToSimilarity(distances[index]),
    }));
}

/**
 * Retrieve the top-K most similar vector hits from ChromaDB.
 *
 * @param {string} question - The user's question.
 * @param {string} collectionName - Name of the ChromaDB collection.
 * @returns {Promise<Object[]>} - Array of hit objects.
 */
async function retrieveVectorHits(question, collectionName, allowedSources = null) {
    const queryEmbedding = await createEmbedding(question);
    const collection = await getCollection(collectionName);

    const queryParams = {
        queryEmbeddings: [queryEmbedding],
        nResults: config.retrieval.retrievalCount,
        include: ["documents", "metadatas", "distances"],
    };

    if (allowedSources && allowedSources.length > 0) {
        if (allowedSources.length === 1) {
            queryParams.where = { source: allowedSources[0] };
        } else {
            queryParams.where = { source: { $in: allowedSources } };
        }
    }

    try {
        const results = await collection.query(queryParams);

        console.log("RAW DISTANCES:");
        console.dir(results.distances, { depth: null });

        return formatResults(results);
    } catch (error) {
        throw createServiceError(
            `Chroma query failed. Make sure the Chroma server is running on ${config.chroma.url}.`
        );
    }
}

// ---------------------------------------------------------------------------
// Similarity Gate — Filter out low-confidence hits
// ---------------------------------------------------------------------------

function applySimilarityGate(hits) {
    return hits.filter(
        (hit) =>
            typeof hit.similarity === "number" &&
            hit.similarity >= config.retrieval.similarityThreshold
    );
}

// ---------------------------------------------------------------------------
// Deduplication Utilities
// ---------------------------------------------------------------------------

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
// Hierarchical Parent Expansion and Deduplication
// ---------------------------------------------------------------------------

function expandHierarchicalParents(childHits) {
    const parentMap = new Map();

    for (const childHit of childHits) {
        const parentId = childHit.metadata.parentId;
        const parentText = childHit.metadata.parentText;

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
                chunkingMethod: "hierarchical",
            },
        });
    }

    const childCount = childHits.length;
    const parentCount = parentMap.size;
    console.log(
        `[Hierarchical Dedup] ${childCount} child hits → ${parentCount} unique parents ` +
            `(${childCount > 0 ? ((1 - parentCount / childCount) * 100).toFixed(1) : 0}% dedup rate)`
    );

    return Array.from(parentMap.values());
}

// ---------------------------------------------------------------------------
// Build Context Chunks
// ---------------------------------------------------------------------------

function buildContextChunks(hits, chunkingMethod) {
    if (chunkingMethod === "hierarchical") {
        return expandHierarchicalParents(hits);
    }

    return dedupeByText(
        hits.map((hit) => ({
            text: hit.text,
            similarity: hit.similarity,
            metadata: hit.metadata,
        }))
    );
}

// ---------------------------------------------------------------------------
// Hybrid Re-Ranking
// ---------------------------------------------------------------------------

/**
 * Apply hybrid re-ranking: blend cosine similarity with keyword match ratio.
 *
 * @param {Object[]} hits - Similarity-gated hits.
 * @param {string} question - The user's question (for keyword extraction).
 * @returns {Object[]} - Top-N re-ranked hits.
 */
function hybridRerank(hits, question) {
    const queryTokens = question
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((token) => token.length > 3);

    const rankedHits = [...hits]
        .map((hit) => {
            const chunkLower = hit.text.toLowerCase();
            const matchCount = queryTokens.filter((token) =>
                chunkLower.includes(token)
            ).length;
            const matchRatio =
                queryTokens.length > 0
                    ? matchCount / queryTokens.length
                    : 0;
            const hybridScore =
                hit.similarity * config.retrieval.hybridWeightSemantic +
                matchRatio * config.retrieval.hybridWeightKeyword;

            return { ...hit, matchRatio, hybridScore };
        })
        .sort((a, b) => b.hybridScore - a.hybridScore)
        .slice(0, config.retrieval.topNChunks);

    console.log(
        `[Hybrid Re-Rank] ${hits.length} filtered hits → top ${rankedHits.length} ` +
            `(threshold=${config.retrieval.similarityThreshold}, topN=${config.retrieval.topNChunks}, queryTokens=${queryTokens.length})`
    );
    rankedHits.forEach((h, i) => {
        console.log(
            `  ${i + 1}. sim=${h.similarity.toFixed(4)} keyword=${h.matchRatio.toFixed(2)} ` +
                `hybrid=${h.hybridScore.toFixed(4)} preview="${h.text.replace(/\s+/g, " ").slice(0, 80)}"`
        );
    });

    return rankedHits;
}

// ---------------------------------------------------------------------------
// Extractive Context Compression
// ---------------------------------------------------------------------------

/**
 * Compresses context by extracting only sentences that match the query keywords.
 * Reduces token usage for large parent chunks.
 *
 * @param {Object[]} hits - Ranked hits.
 * @param {string} question - The user's question.
 * @returns {Object[]} - Compressed hits.
 */
function compressContext(hits, question) {
    const queryTokens = question
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((token) => token.length > 3);

    if (queryTokens.length === 0) return hits;

    return hits.map((hit) => {
        // Skip compression for conversation memory
        if (hit.metadata?.chunkingMethod === "memory") return hit;

        // Split text into sentences (naïve approach using punctuation)
        const sentences = hit.text.match(/[^.!?]+[.!?]+/g) || [hit.text];
        
        const relevantSentences = sentences.filter((sentence) => {
            const sentenceLower = sentence.toLowerCase();
            return queryTokens.some((token) => sentenceLower.includes(token));
        });

        // Always keep the first and last sentence for context boundary if we extract anything
        if (relevantSentences.length > 0 && relevantSentences.length < sentences.length) {
            if (!relevantSentences.includes(sentences[0])) {
                relevantSentences.unshift(sentences[0]);
            }
            if (!relevantSentences.includes(sentences[sentences.length - 1])) {
                relevantSentences.push(sentences[sentences.length - 1]);
            }
            
            // Reconstruct text with ellipses for omitted parts
            let compressedText = "";
            let lastIdx = -1;
            
            for (const sentence of relevantSentences) {
                const idx = sentences.indexOf(sentence);
                if (lastIdx !== -1 && idx > lastIdx + 1) {
                    compressedText += " [...] ";
                }
                compressedText += sentence.trim() + " ";
                lastIdx = idx;
            }
            
            return { ...hit, text: compressedText.trim(), compressed: true };
        }

        return hit;
    });
}

// ---------------------------------------------------------------------------
// Logging: Retrieval diagnostics
// ---------------------------------------------------------------------------

function logRetrievedChunks(rawHits, filteredHits, contextChunks, chunkingMethod) {
    console.log("\nRetrieved vector hits:");

    rawHits.forEach((hit, index) => {
        const source = hit.metadata.source || "unknown";
        const parent = hit.metadata.parentId || "none";
        const chunk =
            hit.metadata.chunkNumber || hit.metadata.childNumber || "unknown";
        const preview = hit.text.replace(/\s+/g, " ").slice(0, 140);

        console.log(
            `${index + 1}. source=${source}, chunk=${chunk}, parent=${parent}, ` +
                `dist=${hit.distance?.toFixed(4)}, sim=${hit.similarity}, preview="${preview}"`
        );
    });

    console.log(
        `Similarity gate: ${filteredHits.length}/${rawHits.length} hits passed >= ${config.retrieval.similarityThreshold}`
    );
    console.log(
        `Context chunks sent to LLM (${chunkingMethod}): ${contextChunks.length}`
    );
}

// ---------------------------------------------------------------------------
// Build Source Metadata
// ---------------------------------------------------------------------------

function buildSources(chunks) {
    return chunks.map((chunk) => ({
        source: chunk.metadata.source || "unknown",
        chunkingMethod: chunk.metadata.chunkingMethod || "standard",
        chunkNumber: chunk.metadata.chunkNumber || null,
        parentId: chunk.metadata.parentId || null,
        parentNumber: chunk.metadata.parentNumber || null,
        matchedChildNumber: chunk.metadata.matchedChildNumber || null,
        similarity: chunk.similarity,
        text: chunk.text,
    }));
}

module.exports = {
    distanceToSimilarity,
    retrieveVectorHits,
    applySimilarityGate,
    expandHierarchicalParents,
    hybridRerank,
    buildContextChunks,
    compressContext,
    logRetrievedChunks,
    buildSources,
    getCollection,
};
