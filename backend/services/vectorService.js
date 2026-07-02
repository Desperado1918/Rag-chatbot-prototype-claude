// ============================================================================
// services/vectorService.js — ChromaDB Abstraction Layer
// ============================================================================
// Thin wrapper over the chromadb npm client. Handles collection creation,
// chunk storage, similarity search, and deletion.
//
// IMPORTANT: We compute embeddings ourselves via @xenova/transformers and
// pass them directly to Chroma. We do NOT rely on Chroma's built-in
// embedding functions, which would use a different model and create
// a mismatch between write-time and query-time embeddings.
// ============================================================================

const { ChromaClient } = require("chromadb");
const { v4: uuidv4 } = require("uuid");
const config = require("../config");
const { embedText, embedBatch } = require("./embeddingService");
const { createServiceError } = require("../utils/errors");

let client = null;
let collection = null;

/**
 * Get the ChromaDB client (lazy-initialized).
 */
function getClient() {
    if (!client) {
        client = new ChromaClient({ path: config.chroma.url });
    }
    return client;
}

/**
 * Initialize (get or create) the conversation_chunks collection.
 * Uses cosine distance as specified.
 */
async function initCollection() {
    if (collection) {
        return collection;
    }

    try {
        const chromaClient = getClient();
        collection = await chromaClient.getOrCreateCollection({
            name: config.chroma.collectionName,
            metadata: { "hnsw:space": "cosine" },
        });

        console.log(`[VectorService] Collection "${config.chroma.collectionName}" ready`);
        return collection;
    } catch (error) {
        console.error("[VectorService] Failed to init ChromaDB collection:", error.message);
        throw createServiceError(
            `ChromaDB is not reachable at ${config.chroma.url}. Make sure the Chroma server is running.`
        );
    }
}

/**
 * Store text chunks with their embeddings and metadata in ChromaDB.
 *
 * @param {Object[]} chunks - Array of chunk objects:
 *   { text: string, chatId: string, messageIds: string[], chunkIndex: number,
 *     source: 'conversation'|'document', documentName?: string }
 * @returns {Promise<string[]>} - Array of stored point IDs.
 */
async function storeChunks(chunks) {
    if (!chunks || chunks.length === 0) return [];

    const coll = await initCollection();

    const ids = chunks.map(() => uuidv4());
    const documents = chunks.map((c) => c.text);
    const embeddings = await embedBatch(documents);

    const metadatas = chunks.map((c) => ({
        chatId: c.chatId,
        // Chroma metadata: flatten messageIds to comma-joined string for compatibility
        messageIds: Array.isArray(c.messageIds) ? c.messageIds.join(",") : (c.messageIds || ""),
        chunkIndex: c.chunkIndex,
        source: c.source || "conversation",
        documentName: c.documentName || "",
        createdAt: new Date().toISOString(),
    }));

    await coll.add({
        ids,
        embeddings,
        documents,
        metadatas,
    });

    console.log(`[VectorService] Stored ${chunks.length} chunk(s) for chat ${chunks[0]?.chatId}`);
    return ids;
}

/**
 * Search for similar chunks by embedding a query text.
 *
 * @param {string} queryText - The text to search for.
 * @param {Object} [options] - Search options.
 * @param {number} [options.topK] - Number of results (default: config.retrieval.topK).
 * @param {string} [options.chatId] - If set, restrict search to this chat only.
 * @returns {Promise<Object[]>} - Array of { id, text, metadata, distance, similarity }.
 */
async function searchSimilar(queryText, options = {}) {
    const coll = await initCollection();
    const topK = options.topK || config.retrieval.topK;

    const queryEmbedding = await embedText(queryText);

    const queryOptions = {
        queryEmbeddings: [queryEmbedding],
        nResults: topK,
    };

    // Optional: filter by chatId
    if (options.chatId) {
        queryOptions.where = { chatId: options.chatId };
    }

    try {
        const results = await coll.query(queryOptions);

        if (!results || !results.ids || results.ids.length === 0) {
            return [];
        }

        // Flatten the nested arrays Chroma returns
        const ids = results.ids[0] || [];
        const documents = results.documents?.[0] || [];
        const metadatas = results.metadatas?.[0] || [];
        const distances = results.distances?.[0] || [];

        return ids.map((id, i) => ({
            id,
            text: documents[i] || "",
            metadata: metadatas[i] || {},
            distance: distances[i],
            similarity: typeof distances[i] === "number" ? Number((1 - distances[i]).toFixed(4)) : null,
        }));
    } catch (error) {
        console.error("[VectorService] Search failed:", error.message);
        return [];
    }
}

/**
 * Delete all chunks belonging to a specific chat.
 * Called when a chat is deleted (cascade).
 *
 * @param {string} chatId - The chat ID whose chunks to delete.
 */
async function deleteByChat(chatId) {
    try {
        const coll = await initCollection();
        await coll.delete({ where: { chatId } });
        console.log(`[VectorService] Deleted all chunks for chat ${chatId}`);
    } catch (error) {
        console.error(`[VectorService] Failed to delete chunks for chat ${chatId}:`, error.message);
    }
}

/**
 * Get all chunks for a chat (for the debug endpoint).
 *
 * @param {string} chatId - The chat ID to inspect.
 * @returns {Promise<Object[]>} - Array of chunk objects with metadata.
 */
async function getChunksByChat(chatId) {
    try {
        const coll = await initCollection();
        const results = await coll.get({
            where: { chatId },
            include: ["documents", "metadatas", "embeddings"],
        });

        if (!results || !results.ids) {
            return [];
        }

        return results.ids.map((id, i) => ({
            id,
            text: results.documents?.[i] || "",
            metadata: results.metadatas?.[i] || {},
            // Only include first 5 dimensions of embedding for preview
            embeddingPreview: results.embeddings?.[i]?.slice(0, 5) || [],
        }));
    } catch (error) {
        console.error(`[VectorService] Failed to get chunks for chat ${chatId}:`, error.message);
        return [];
    }
}

module.exports = {
    initCollection,
    storeChunks,
    searchSimilar,
    deleteByChat,
    getChunksByChat,
};
