// ============================================================================
// controllers/documentController.js — Document Upload & Ingestion
// ============================================================================

const path = require("path");
const Document = require("../models/Document");
const { ingestDocument, normalizeChunkingMethod, getCollectionName } = require("../services/ingestion");
const { logEvent } = require("../services/analytics");

/**
 * Upload and ingest a PDF document.
 * Uses multer (configured in routes) for file handling.
 */
async function uploadDocument(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        const chunkingMethod = normalizeChunkingMethod(req.body.chunkingMethod);
        const conversationId = req.body.conversationId || null;

        // Create document record
        const doc = await Document.create({
            filename: req.file.filename,
            originalName: req.file.originalname,
            filepath: req.file.path,
            conversationId,
            embeddingStatus: "processing",
            chunkingMethod,
            fileSize: req.file.size,
        });

        // Run ingestion pipeline
        try {
            const startTime = Date.now();
            const result = await ingestDocument(req.file.path, {
                chunkingMethod,
            });

            doc.embeddingStatus = "completed";
            doc.chunkCount = result.recordsStored;
            doc.collectionName = result.collection;
            await doc.save();

            logEvent("document_uploaded", {
                filename: req.file.originalname,
                fileSize: req.file.size,
                durationMs: Date.now() - startTime,
                chunkCount: result.recordsStored,
                chunkingMethod,
            });

            res.json({
                document: doc,
                ingestion: result,
            });
        } catch (ingestError) {
            doc.embeddingStatus = "failed";
            doc.metadata = { error: ingestError.message };
            await doc.save();

            res.status(500).json({
                error: "Ingestion failed: " + ingestError.message,
                document: doc,
            });
        }
    } catch (error) {
        console.error("[documentController] uploadDocument:", error);
        res.status(500).json({ error: "Failed to upload document" });
    }
}

/**
 * List all uploaded documents.
 */
async function listDocuments(req, res) {
    try {
        const documents = await Document.find()
            .sort({ createdAt: -1 })
            .lean();

        res.json({ documents });
    } catch (error) {
        console.error("[documentController] listDocuments:", error);
        res.status(500).json({ error: "Failed to list documents" });
    }
}

/**
 * List documents for a specific conversation.
 */
async function listConversationDocuments(req, res) {
    try {
        const documents = await Document.find({
            conversationId: req.params.id,
        })
            .sort({ createdAt: -1 })
            .lean();

        res.json({ documents });
    } catch (error) {
        console.error(
            "[documentController] listConversationDocuments:",
            error
        );
        res.status(500).json({ error: "Failed to list documents" });
    }
}

/**
 * Legacy ingest endpoint — ingests the default document.
 */
async function ingestDefault(req, res) {
    try {
        const chunkingMethod = normalizeChunkingMethod(req.body.chunkingMethod);
        const result = await ingestDocument(undefined, { chunkingMethod });

        res.json(result);
    } catch (error) {
        console.error("[documentController] ingestDefault:", error);
        res.status(error.statusCode || 500).json({
            error: error.message || "Ingestion failed",
        });
    }
}

module.exports = {
    uploadDocument,
    listDocuments,
    listConversationDocuments,
    ingestDefault,
};
