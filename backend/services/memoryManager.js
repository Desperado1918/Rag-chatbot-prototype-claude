// ============================================================================
// services/memoryManager.js — Conversation Memory Manager
// ============================================================================
// Chunks conversations into ChromaDB for long-term semantic memory.
// Messages are grouped by topic windows and stored in a dedicated
// `conversation_memory` collection, separate from document embeddings.
// ============================================================================

const { ChromaClient } = require("chromadb");
const config = require("../config");
const { createEmbedding } = require("./embedding");
const Message = require("../models/Message");

const MEMORY_COLLECTION = "conversation_memory";

/**
 * Get or create the conversation memory collection in ChromaDB.
 */
async function getMemoryCollection() {
    const client = new ChromaClient({ path: config.chroma.url });

    return client.getOrCreateCollection({
        name: MEMORY_COLLECTION,
        metadata: { "hnsw:space": "cosine" },
    });
}

/**
 * Index a conversation's messages into ChromaDB for semantic memory retrieval.
 * Groups messages into topic windows (not individual messages) for better
 * context preservation.
 *
 * @param {string} conversationId - The conversation to index.
 * @param {Object} [options] - Configuration options.
 * @param {number} [options.windowSize=4] - Messages per topic window.
 * @param {number} [options.windowOverlap=1] - Overlap between windows.
 */
async function indexConversationMemory(conversationId, options = {}) {
    const windowSize = options.windowSize || 4;
    const windowOverlap = options.windowOverlap || 1;

    try {
        const messages = await Message.find({ conversationId })
            .sort({ createdAt: 1 })
            .lean();

        if (messages.length < windowSize) {
            return { indexed: 0 }; // Not enough messages to create windows
        }

        const collection = await getMemoryCollection();

        // Create sliding windows of messages
        const windows = [];
        const step = windowSize - windowOverlap;

        for (let i = 0; i <= messages.length - windowSize; i += step) {
            const windowMessages = messages.slice(i, i + windowSize);

            const windowText = windowMessages
                .map((m) => {
                    const role = m.role === "user" ? "User" : "Assistant";
                    return `${role}: ${m.content}`;
                })
                .join("\n\n");

            // Limit window text to prevent overly large embeddings
            const truncatedText =
                windowText.length > 2000
                    ? windowText.slice(0, 2000)
                    : windowText;

            const firstMsg = windowMessages[0];
            const lastMsg = windowMessages[windowMessages.length - 1];

            windows.push({
                id: `memory-${conversationId}-window-${i}`,
                text: truncatedText,
                metadata: {
                    conversationId: conversationId.toString(),
                    messageRangeStart: i,
                    messageRangeEnd: i + windowSize - 1,
                    windowIndex: Math.floor(i / step),
                    firstTimestamp: firstMsg.createdAt.toISOString(),
                    lastTimestamp: lastMsg.createdAt.toISOString(),
                    type: "conversation_memory",
                },
            });
        }

        // Delete existing windows for this conversation before re-indexing
        try {
            const existingIds = windows.map((w) => w.id);
            await collection.delete({ ids: existingIds });
        } catch (_) {
            // Collection might not have these IDs yet, that's fine
        }

        // Embed and store each window
        let indexed = 0;
        for (const window of windows) {
            try {
                const embedding = await createEmbedding(window.text);

                await collection.upsert({
                    ids: [window.id],
                    embeddings: [embedding],
                    documents: [window.text],
                    metadatas: [window.metadata],
                });

                indexed++;
            } catch (err) {
                console.error(
                    `[MemoryManager] Failed to index window ${window.id}:`,
                    err.message
                );
            }
        }

        console.log(
            `[MemoryManager] Indexed ${indexed}/${windows.length} windows ` +
                `for conversation ${conversationId}`
        );

        return { indexed, total: windows.length };
    } catch (error) {
        console.error(
            "[MemoryManager] indexConversationMemory failed:",
            error.message
        );
        return { indexed: 0, error: error.message };
    }
}

/**
 * Search conversation memory for semantically similar past discussions.
 *
 * @param {string} query - The search query text.
 * @param {Object} [options] - Search options.
 * @param {number} [options.nResults=3] - Number of results to return.
 * @param {string} [options.excludeConversationId] - Exclude a specific conversation.
 * @returns {Promise<Object[]>} - Array of memory hits.
 */
async function searchMemory(query, options = {}) {
    const nResults = options.nResults || 3;

    try {
        const collection = await getMemoryCollection();
        const queryEmbedding = await createEmbedding(query);

        const whereFilter = options.excludeConversationId
            ? { conversationId: { $ne: options.excludeConversationId } }
            : undefined;

        const results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults,
            include: ["documents", "metadatas", "distances"],
            where: whereFilter,
        });

        const documents = results.documents?.[0] || [];
        const metadatas = results.metadatas?.[0] || [];
        const distances = results.distances?.[0] || [];

        return documents.map((doc, i) => ({
            text: doc,
            metadata: metadatas[i] || {},
            distance: distances[i],
            similarity: typeof distances[i] === "number"
                ? Number((1 - distances[i]).toFixed(4))
                : null,
        }));
    } catch (error) {
        // Collection might not exist yet, return empty
        console.error(
            "[MemoryManager] searchMemory failed:",
            error.message
        );
        return [];
    }
}

module.exports = {
    MEMORY_COLLECTION,
    getMemoryCollection,
    indexConversationMemory,
    searchMemory,
};
