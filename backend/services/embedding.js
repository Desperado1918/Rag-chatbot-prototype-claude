// ============================================================================
// services/embedding.js — Shared Embedding Service
// ============================================================================
// Single source for all embedding operations. Both ingestion and retrieval
// import from here, eliminating the duplicated createEmbedding() functions.
// ============================================================================

const { embedText } = require("./embeddingService");

/**
 * Generate an embedding vector for the given text using the in-process
 * @xenova/transformers embedding model.
 *
 * @param {string} text - Text to embed.
 * @returns {Promise<number[]>} - Embedding vector.
 */
async function createEmbedding(text) {
    return embedText(text);
}

module.exports = { createEmbedding };
