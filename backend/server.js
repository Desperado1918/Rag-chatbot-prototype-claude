// ============================================================================
// server.js — Express 5 Application Entry Point
// ============================================================================
// Sets up the Express app with:
//   - pino structured logging
//   - CORS
//   - Static file serving for the vanilla JS frontend
//   - Clean route mounting matching the spec API surface
//   - Legacy route compatibility
//   - Centralized error handling (Express 5 async-friendly)
//   - Health check endpoint surfacing memory-server status
// ============================================================================

const path = require("path");
const express = require("express");
const cors = require("cors");
const pino = require("pino");
const pinoHttp = require("pino-http");
const config = require("./config");
const { connectDatabase, isDatabaseConnected, isUsingMemoryServer } = require("./db/connection");
const errorHandler = require("./middleware/errorHandler");

// Route imports — new spec API
const chatRoutes = require("./routes/chats");
const searchRoutes = require("./routes/search");
const debugRoutes = require("./routes/debug");
const documentRoutes = require("./routes/documents");
const messageRoutes = require("./routes/messages");

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = pino({
    level: config.log.level,
    transport: config.nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
        : undefined,
});

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health" } }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Ensure uploads directory exists
const fs = require("fs");
const uploadsDir = path.resolve(config.documents.uploadDir);
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.use("/api/chats", chatRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/debug", debugRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api", messageRoutes);

// Health check — surfaces database status including memory-server fallback
app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        database: {
            connected: isDatabaseConnected(),
            usingMemoryServer: isUsingMemoryServer(),
        },
        environment: config.nodeEnv,
        chatProvider: config.chatProvider,
        embeddingModel: config.embedding.model,
    });
});

// Serve index.html for the root route
app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// ---------------------------------------------------------------------------
// Centralized Error Handler (must be last middleware)
// ---------------------------------------------------------------------------
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------
async function startServer() {
    try {
        await connectDatabase();
        logger.info("[Startup] MongoDB connected.");
    } catch (error) {
        logger.fatal({ err: error }, "[Startup] MongoDB connection failed fatally.");
        process.exit(1);
    }

    app.listen(config.port, () => {
        logger.info(`Server running on http://localhost:${config.port}`);
        logger.info(`Environment: ${config.nodeEnv}`);
        logger.info(`Chat provider: ${config.chatProvider} (${config.ollama.chatModel})`);
        logger.info(`Embedding model: ${config.embedding.model} (in-process)`);

        if (isUsingMemoryServer()) {
            logger.warn("⚠ Running on in-memory database — data will NOT persist across restarts!");
        }
    });
}

startServer();
