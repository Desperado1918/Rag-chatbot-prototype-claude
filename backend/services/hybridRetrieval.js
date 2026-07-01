// ============================================================================
// services/hybridRetrieval.js — Dual-Context Hybrid Retrieval
// ============================================================================
// Enhanced retrieval that searches both document embeddings and conversation
// memory embeddings. Merges results, applies the hybrid re-ranker, and
// returns the top chunks for the LLM.
// ============================================================================

const {
    retrieveVectorHits,
    applySimilarityGate,
    expandHierarchicalParents,
    hybridRerank,
    compressContext,
    logRetrievedChunks,
    buildSources,
} = require("./retrieval");
const { getCollectionName } = require("./ingestion");
const { searchMemory } = require("./memoryManager");
const { getConversationSummary } = require("./conversationSummarizer");
const Document = require("../models/Document");

/**
 * Perform hybrid dual-context retrieval for a given question.
 * Searches both document space and memory space.
 *
 * @param {string} question - User's question.
 * @param {Object} options - Configuration options.
 * @param {string} options.chunkingMethod - "standard" or "hierarchical".
 * @param {string} options.conversationId - Current conversation ID.
 * @returns {Promise<Object>} - Contains merged hits, sources, and conversation context.
 */
async function performHybridDualRetrieval(question, options = {}) {
    const chunkingMethod = options.chunkingMethod || "hierarchical";
    const collectionName = getCollectionName(chunkingMethod);
    const conversationId = options.conversationId;

    // Fetch documents associated with this conversation
    let allowedSources = null;
    if (conversationId) {
        try {
            const conversationDocs = await Document.find({
                conversationId,
                embeddingStatus: "completed"
            }).lean();
            
            if (conversationDocs.length > 0) {
                allowedSources = conversationDocs.map(d => d.filename);
            }
        } catch (err) {
            console.warn("[HybridDualRetrieval] Failed to load associated documents:", err.message);
        }
    }

    // 1. Fetch from Document Space (ChromaDB)
    let rawDocHits = [];
    try {
        rawDocHits = await retrieveVectorHits(question, collectionName, allowedSources);
    } catch (err) {
        console.warn("[HybridDualRetrieval] Document retrieval failed:", err.message);
    }

    // 2. Fetch from Memory Space (ChromaDB)
    let rawMemoryHits = [];
    if (conversationId) {
        try {
            // Search memory, excluding the current conversation's own memory windows
            // (we handle recent context directly, memory is for past conversations)
            rawMemoryHits = await searchMemory(question, {
                nResults: 3,
                excludeConversationId: conversationId.toString(),
            });
        } catch (err) {
            console.warn("[HybridDualRetrieval] Memory retrieval failed:", err.message);
        }
    }

    // 3. Apply Similarity Gate to Document Hits
    const filteredDocHits = applySimilarityGate(rawDocHits);
    let contextChunks = [];

    if (chunkingMethod === "hierarchical") {
        contextChunks = expandHierarchicalParents(filteredDocHits);
    } else {
        // Simple deduplication for standard chunks
        const seen = new Set();
        contextChunks = filteredDocHits.filter((hit) => {
            const key = hit.text.trim().toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    logRetrievedChunks(rawDocHits, filteredDocHits, contextChunks, chunkingMethod);

    // 4. Merge Memory Hits with Document Hits
    // We treat memory hits similarly to document hits but tag them explicitly
    const mergedHits = [...contextChunks];

    if (rawMemoryHits.length > 0) {
        const filteredMemoryHits = applySimilarityGate(rawMemoryHits);
        for (const hit of filteredMemoryHits) {
            mergedHits.push({
                text: hit.text,
                similarity: hit.similarity,
                metadata: {
                    ...hit.metadata,
                    source: "Conversation Memory",
                    chunkingMethod: "memory",
                },
            });
        }
        console.log(`[HybridDualRetrieval] Added ${filteredMemoryHits.length} memory hits to context.`);
    }

    // 5. Re-rank the merged hits using hybrid (semantic + keyword) scoring
    const rankedHits = hybridRerank(mergedHits, question);

    // 5b. Compress context to extract relevant sentences
    const compressedHits = compressContext(rankedHits, question);

    // 6. Fetch long-term summary context for the CURRENT conversation
    let conversationContext = "";
    if (conversationId) {
        const summaryObj = await getConversationSummary(conversationId);
        if (summaryObj) {
            conversationContext = `Summary of older messages in this conversation:\n${summaryObj.summary}`;
        }
    }

    return {
        contextChunks: compressedHits,
        sources: buildSources(compressedHits),
        conversationContext,
        chunkingMethod,
    };
}

module.exports = {
    performHybridDualRetrieval,
};
