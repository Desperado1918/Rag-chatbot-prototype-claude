// ============================================================================
// ingest.js — Thin Facade (Backward-Compatible)
// ============================================================================
// This file now delegates to the modular services under backend/services/.
// It preserves the exact same public API so that server.js and benchmark.js
// continue to work without any import changes.
// ============================================================================

const config = require("./backend/config");
const {
    cleanExtractedText,
    createHierarchicalChunks,
    createStandardRecords,
    getCollectionName,
    getOrCreateCollection,
    ingestDocument,
    loadPdfText,
    normalizeChunkingMethod,
    safeSplitText,
} = require("./backend/services/ingestion");
const { createEmbedding } = require("./backend/services/embedding");

// ---------------------------------------------------------------------------
// Re-export constants for backward compatibility (benchmark.js uses these)
// ---------------------------------------------------------------------------

const PARENT_CHUNK_SIZE = config.chunking.parentChunkSize;
const CHILD_CHUNK_SIZE = config.chunking.childChunkSize;
const STANDARD_CHUNK_SIZE = config.chunking.standardChunkSize;
const DOCUMENT_PATH = config.documents.defaultPath;

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
    const chunkingMethod = process.argv[2] || "hierarchical";
    await ingestDocument(DOCUMENT_PATH, { chunkingMethod });
}

if (require.main === module) {
    main().catch(console.error);
}

// ---------------------------------------------------------------------------
// Exports — Exact same public API as before
// ---------------------------------------------------------------------------

module.exports = {
    createHierarchicalChunks,
    createStandardRecords,
    getCollectionName,
    getOrCreateCollection,
    ingestDocument,
    loadPdfText,
    normalizeChunkingMethod,
    safeSplitText,
    createEmbedding,
    // Export constants for benchmark access
    PARENT_CHUNK_SIZE,
    CHILD_CHUNK_SIZE,
    STANDARD_CHUNK_SIZE,
    DOCUMENT_PATH,
};
