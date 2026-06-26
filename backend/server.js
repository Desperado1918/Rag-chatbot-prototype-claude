// ============================================================================
// server.js — RAG Chatbot Backend (PageIndex + Ollama)
// ============================================================================
// Express server providing:
//   POST /upload         — Upload PDF to PageIndex for tree indexing
//   POST /ingest         — Ingest default PDF to PageIndex
//   POST /chat/stream    — Stream answers (PageIndex retrieval → Ollama gen)
//   GET  /status         — Check if a document is loaded
//   GET  /               — Health check
// ============================================================================

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { askQuestionStream } = require("../query");
const { ingestDocument, getDocId, loadState, ensureUploadsDir } = require("../ingest");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---------------------------------------------------------------------------
// Multer Configuration — PDF uploads
// ---------------------------------------------------------------------------

const uploadsDir = ensureUploadsDir();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Preserve original filename, add timestamp to avoid collisions
        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, `${timestamp}-${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            cb(new Error("Only PDF files are accepted"), false);
        }
    }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserMessage(req) {
    return req.body.message?.trim();
}

function sendJsonError(res, error) {
    res.status(error.statusCode || 500).json({
        error: error.message || "Something went wrong"
    });
}

function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
    res.json({ message: "Backend is running" });
});

/**
 * GET /status — Check if a document has been ingested.
 * Returns the current state (doc_id, source filename, upload time).
 */
app.get("/status", (req, res) => {
    const state = loadState();

    if (state && state.doc_id) {
        res.json({
            ready: true,
            doc_id: state.doc_id,
            source: state.source,
            uploaded_at: state.uploaded_at
        });
    } else {
        res.json({ ready: false });
    }
});

/**
 * POST /upload — Upload a PDF file and ingest it via PageIndex.
 * Accepts multipart/form-data with a 'file' field.
 */
app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
    }

    try {
        console.log(`[Upload] Received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

        const result = await ingestDocument(req.file.path, (msg) => {
            console.log(`[Ingest] ${msg}`);
        });

        res.json(result);
    } catch (error) {
        console.error("[Upload Error]", error);
        sendJsonError(res, error);
    }
});

/**
 * POST /ingest — Upload the default PDF to PageIndex for indexing.
 * This triggers document parsing, structure extraction, and tree building.
 * Responds when processing is complete (may take 30–120 seconds).
 */
app.post("/ingest", async (req, res) => {
    try {
        const result = await ingestDocument(undefined, (msg) => {
            console.log(`[Ingest] ${msg}`);
        });

        res.json(result);
    } catch (error) {
        console.error("[Ingest Error]", error);
        sendJsonError(res, error);
    }
});

/**
 * POST /chat/stream — Stream an answer using the hybrid RAG pipeline.
 * Stage 1: PageIndex retrieves relevant document sections.
 * Stage 2: Ollama/Qwen generates a grounded answer.
 * Uses Server-Sent Events (SSE) for real-time token delivery.
 */
app.post("/chat/stream", async (req, res) => {
    const userMessage = getUserMessage(req);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (!userMessage) {
        writeSse(res, "error", { error: "Message is required" });
        res.end();
        return;
    }

    try {
        await askQuestionStream(userMessage, {
            onSources: (sources) => {
                writeSse(res, "sources", { sources });
            },
            onToken: (token) => {
                writeSse(res, "token", { token });
            },
            onDone: () => {
                writeSse(res, "done", { done: true });
                res.end();
            }
        });
    } catch (error) {
        console.error("[Chat Error]", error);
        writeSse(res, "error", {
            error: error.message || "Something went wrong"
        });
        res.end();
    }
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
    const docId = getDocId();
    const model = process.env.OLLAMA_MODEL || "qwen2.5:7b";
    console.log(`\n  RAG Chatbot Server running on http://localhost:${PORT}`);
    console.log(`  Frontend: http://localhost:${PORT}`);
    console.log(`  LLM Model: ${model} (via Ollama)`);
    console.log(`  Document: ${docId ? "Loaded (" + docId.slice(0, 12) + "...)" : "Not ingested yet"}`);
    console.log();
});
