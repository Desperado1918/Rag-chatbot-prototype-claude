// ============================================================================
// config/index.js — Centralized Configuration
// ============================================================================
// All configurable values live here. Environment variables override defaults.
// This prevents hardcoded URLs/models from being scattered across modules.
// ============================================================================

require("dotenv").config();

const config = {
    // -----------------------------------------------------------------------
    // Server
    // -----------------------------------------------------------------------
    port: parseInt(process.env.PORT, 10) || 3000,

    // -----------------------------------------------------------------------
    // MongoDB
    // -----------------------------------------------------------------------
    mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/rag-chatbot",

    // -----------------------------------------------------------------------
    // Ollama — Local LLM
    // -----------------------------------------------------------------------
    ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
        chatModel: process.env.OLLAMA_MODEL || "qwen2.5:7b",
        embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
        contextWindow: parseInt(process.env.OLLAMA_CONTEXT_WINDOW, 10) || 8192,
    },

    // -----------------------------------------------------------------------
    // ChromaDB — Vector Store
    // -----------------------------------------------------------------------
    chroma: {
        url: process.env.CHROMA_URL || "http://localhost:8000",
    },

    // -----------------------------------------------------------------------
    // PageIndex
    // -----------------------------------------------------------------------
    pageindex: {
        apiKey: process.env.PAGEINDEX_API_KEY || "",
    },

    // -----------------------------------------------------------------------
    // Retrieval Tuning
    // -----------------------------------------------------------------------
    retrieval: {
        retrievalCount: 20,          // Wider initial net for hybrid re-ranker
        topNChunks: 5,               // Keep top 5 after re-ranking
        similarityThreshold: 0.40,   // Minimum cosine similarity to pass gate
        hybridWeightSemantic: 0.7,   // 70% cosine similarity
        hybridWeightKeyword: 0.3,    // 30% keyword match
    },

    // -----------------------------------------------------------------------
    // Chunking Parameters
    // -----------------------------------------------------------------------
    chunking: {
        standardChunkSize: 1200,
        parentChunkSize: 2200,
        childChunkSize: 500,
        overlapSize: 80,
        separators: ["\n\n", "\n", ". ", " "],
    },

    // -----------------------------------------------------------------------
    // Document Defaults
    // -----------------------------------------------------------------------
    documents: {
        defaultPath: "./documents/notes.pdf",
        uploadDir: "./uploads",
    },

    // -----------------------------------------------------------------------
    // LLM Generation
    // -----------------------------------------------------------------------
    generation: {
        temperature: 0.0,
        topP: 0.9,
        repeatPenalty: 1.1,
    },

    // -----------------------------------------------------------------------
    // Conversation
    // -----------------------------------------------------------------------
    conversation: {
        titleGenerationThreshold: 2,  // Generate title after N user messages
        summaryThreshold: 20,         // Summarize after N messages
        maxTitleLength: 5,            // Max words in auto-generated title
    },

    // -----------------------------------------------------------------------
    // Analytics
    // -----------------------------------------------------------------------
    analytics: {
        eventsFile: "./analytics/events.jsonl",
    },

    // -----------------------------------------------------------------------
    // Safe Refusal
    // -----------------------------------------------------------------------
    safeUnknownAnswer: "I don't know based on the provided documents.",
};

module.exports = config;
