// ============================================================================
// ingest.js — PageIndex Document Ingestion
// ============================================================================
// Uploads a PDF to PageIndex's cloud API for tree-based indexing.
// PageIndex automatically parses the document structure (headings, sections,
// tables, figures) and builds a hierarchical tree index — no chunking,
// embedding, or vector DB required.
//
// Supports both CLI usage (default document) and server-driven uploads
// (dynamic file paths from the /upload endpoint).
// ============================================================================

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { PageIndexClient } = require("@pageindex/sdk");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DOCUMENT_PATH = "./documents/notes.pdf";
const STATE_FILE = "./pageindex_state.json";
const UPLOADS_DIR = "./uploads";

// ---------------------------------------------------------------------------
// PageIndex Client
// ---------------------------------------------------------------------------

function getClient() {
    const apiKey = process.env.PAGEINDEX_API_KEY;

    if (!apiKey || apiKey === "your_api_key_here") {
        throw new Error(
            "PAGEINDEX_API_KEY is not set. Copy .env.example to .env and add your API key from https://dash.pageindex.ai"
        );
    }

    return new PageIndexClient({ apiKey });
}

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

/**
 * Load the saved PageIndex state (doc_id, processing status, etc.)
 * from the local JSON file.
 *
 * @returns {Object|null} - Saved state or null if none exists.
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        }
    } catch (error) {
        console.warn("Could not load PageIndex state:", error.message);
    }

    return null;
}

/**
 * Save PageIndex state to disk so it persists across server restarts.
 *
 * @param {Object} state - State object to persist.
 */
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get the currently stored doc_id, or null if no document has been ingested.
 *
 * @returns {string|null} - The doc_id or null.
 */
function getDocId() {
    const state = loadState();
    return state?.doc_id || null;
}

// ---------------------------------------------------------------------------
// Document Upload & Processing
// ---------------------------------------------------------------------------

/**
 * Wait for PageIndex to finish processing a document.
 * Polls the API every few seconds until status is "completed".
 *
 * @param {PageIndexClient} client - Initialized PageIndex client.
 * @param {string} docId - The document ID to poll.
 * @param {Function} [onProgress] - Optional callback for progress updates.
 * @returns {Promise<Object>} - The completed tree result.
 */
async function waitForProcessing(client, docId, onProgress) {
    const MAX_POLLS = 120; // 10 minutes max (120 × 5s)
    const POLL_INTERVAL = 5000; // 5 seconds

    for (let i = 0; i < MAX_POLLS; i++) {
        try {
            const result = await client.api.getTree(docId);

            if (result.status === "completed") {
                onProgress?.("Processing complete");
                return result;
            }

            const message = `Processing... (${i + 1}/${MAX_POLLS})`;
            onProgress?.(message);
            console.log(message);
        } catch (error) {
            console.warn(`Poll ${i + 1} failed:`, error.message);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    throw new Error("Document processing timed out after 10 minutes.");
}

/**
 * Upload a PDF document to PageIndex and wait for it to be indexed.
 * The doc_id is saved locally for subsequent chat queries.
 *
 * @param {string} filePath - Path to the PDF file.
 * @param {Function} [onProgress] - Optional callback for status updates.
 * @returns {Promise<Object>} - Ingestion result { doc_id, status, source }.
 */
async function ingestDocument(filePath = DOCUMENT_PATH, onProgress) {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Document not found at: ${absolutePath}`);
    }

    const client = getClient();
    const sourceFilename = path.basename(filePath);

    onProgress?.("Uploading document to PageIndex...");
    console.log(`Uploading: ${sourceFilename}`);

    // Read the file and upload to PageIndex
    const fileBuffer = fs.readFileSync(absolutePath);
    const uploadResult = await client.api.submitDocument(fileBuffer, sourceFilename);
    const docId = uploadResult.doc_id;

    console.log(`Document uploaded. doc_id: ${docId}`);
    onProgress?.("Document uploaded. Building tree index...");

    // Wait for PageIndex to finish parsing and indexing
    await waitForProcessing(client, docId, onProgress);

    // Save the state for future queries
    const state = {
        doc_id: docId,
        source: sourceFilename,
        uploaded_at: new Date().toISOString(),
        status: "ready"
    };

    saveState(state);
    console.log("Document indexed and ready for queries.");

    return state;
}

/**
 * Ensure the uploads directory exists.
 */
function ensureUploadsDir() {
    const dir = path.resolve(UPLOADS_DIR);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
    const customPath = process.argv[2];
    const targetPath = customPath || DOCUMENT_PATH;

    const result = await ingestDocument(targetPath, (msg) => {
        console.log(`[Status] ${msg}`);
    });
    console.log("\nIngestion complete:", result);
}

if (require.main === module) {
    main().catch(console.error);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    ingestDocument,
    getDocId,
    getClient,
    loadState,
    saveState,
    ensureUploadsDir,
    DOCUMENT_PATH,
    UPLOADS_DIR
};
