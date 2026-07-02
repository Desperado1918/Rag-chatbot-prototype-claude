// ============================================================================
// services/embeddingService.js — In-Process Embedding via @xenova/transformers
// ============================================================================
// Runs the embedding model INSIDE the Node.js process using ONNX Runtime.
// No external server, no HTTP call, no Ollama dependency for embeddings.
//
// The model is downloaded on first use (~30MB for all-MiniLM-L6-v2) and
// cached locally. Subsequent calls load from cache instantly.
// ============================================================================

const config = require("../config");
const { createServiceError } = require("../utils/errors");

let pipelineInstance = null;
let isLoading = false;
let loadingPromise = null;

/**
 * Lazily initialize the embedding pipeline.
 * The first call downloads the model; subsequent calls return the cached instance.
 */
async function getPipeline() {
    if (pipelineInstance) {
        return pipelineInstance;
    }

    // Prevent concurrent initialization
    if (isLoading) {
        return loadingPromise;
    }

    isLoading = true;
    console.log(`[EmbeddingService] Loading model: ${config.embedding.model} ...`);

    loadingPromise = (async () => {
        try {
            // Dynamic import — @xenova/transformers is ESM-compatible
            const { pipeline } = await import("@xenova/transformers");

            pipelineInstance = await pipeline(
                "feature-extraction",
                config.embedding.model,
                { quantized: true } // Use quantized model for speed
            );

            console.log(`[EmbeddingService] Model loaded successfully (${config.embedding.dimensions}-dim)`);
            return pipelineInstance;
        } catch (error) {
            isLoading = false;
            loadingPromise = null;
            throw createServiceError(
                `Failed to load embedding model "${config.embedding.model}": ${error.message}`
            );
        } finally {
            isLoading = false;
        }
    })();

    return loadingPromise;
}

/**
 * Embed a single text string.
 *
 * @param {string} text - Text to embed.
 * @returns {Promise<number[]>} - Embedding vector (384-dim for all-MiniLM-L6-v2).
 */
async function embedText(text) {
    if (!text || typeof text !== "string") {
        throw createServiceError("embedText requires a non-empty string", 400);
    }

    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });

    // output is a Tensor — convert to a plain JS array
    return Array.from(output.data);
}

/**
 * Embed multiple texts in batch.
 *
 * @param {string[]} texts - Array of texts to embed.
 * @returns {Promise<number[][]>} - Array of embedding vectors.
 */
async function embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
        return [];
    }

    const pipe = await getPipeline();
    const results = [];

    // Process sequentially to avoid memory spikes with large batches
    for (const text of texts) {
        const output = await pipe(text, { pooling: "mean", normalize: true });
        results.push(Array.from(output.data));
    }

    return results;
}

module.exports = { embedText, embedBatch, getPipeline };
