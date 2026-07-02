// ============================================================================
// controllers/debugController.js — ChromaDB Chunk Inspector
// ============================================================================
// GET /api/debug/chunks/:chatId
// Primary visibility tool for the vector store (per Assumption 5).
// Returns all chunks stored in ChromaDB for a given chat.
// ============================================================================

const { getChunksByChat } = require("../services/vectorService");

/**
 * Get all stored chunks for a chat.
 *
 * Response: {
 *   chatId: string,
 *   totalChunks: number,
 *   chunks: Array<{ id, text, metadata, embeddingPreview }>
 * }
 */
async function getChunks(req, res) {
    const { chatId } = req.params;

    const chunks = await getChunksByChat(chatId);

    res.json({
        chatId,
        totalChunks: chunks.length,
        chunks,
    });
}

module.exports = { getChunks };
