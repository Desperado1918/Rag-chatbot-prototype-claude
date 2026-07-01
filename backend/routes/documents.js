// ============================================================================
// routes/documents.js — Document REST API
// ============================================================================

const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const config = require("../config");
const ctrl = require("../controllers/documentController");

// Configure multer for PDF uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, config.documents.uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") {
            cb(null, true);
        } else {
            cb(new Error("Only PDF files are allowed"), false);
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max
    },
});

const router = Router();

// Upload and ingest a PDF
router.post("/upload", upload.single("document"), ctrl.uploadDocument);

// List all documents
router.get("/", ctrl.listDocuments);

// List documents for a conversation
router.get("/conversations/:id", ctrl.listConversationDocuments);

// Legacy: ingest default document
router.post("/ingest", ctrl.ingestDefault);

module.exports = router;
