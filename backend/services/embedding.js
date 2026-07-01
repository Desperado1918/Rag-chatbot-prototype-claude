// ============================================================================
// services/embedding.js — Shared Embedding Service
// ============================================================================
// Single source for all embedding operations. Both ingestion and retrieval
// import from here, eliminating the duplicated createEmbedding() functions.
// ============================================================================

const axios = require("axios");
const config = require("../config");
const { createServiceError } = require("../utils/errors");

/**
 * Generate an embedding vector for the given text using Ollama's local
 * embedding model. This never leaves the machine.
 *
 * @param {string} text - Text to embed.
 * @returns {Promise<number[]>} - Embedding vector.
 */
async function createEmbedding(text) {
    try {
        const response = await axios.post(
            `${config.ollama.baseUrl}/api/embeddings`,
            {
                model: config.ollama.embeddingModel,
                prompt: text,
            }
        );

        return response.data.embedding;
    } catch (error) {
        throw createServiceError(
            `Ollama embedding model is not responding. Make sure Ollama is running and the ${config.ollama.embeddingModel} model is installed.`
        );
    }
}

module.exports = { createEmbedding };
