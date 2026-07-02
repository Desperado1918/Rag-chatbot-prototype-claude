// ============================================================================
// config/index.js — Centralized Configuration
// ============================================================================
// All configurable values live here. Environment variables override defaults.
// This prevents hardcoded URLs/models from being scattered across modules.
// ============================================================================

require("dotenv").config();

const config = {
    // -----------------------------------------------------------------------
    // Environment
    // -----------------------------------------------------------------------
    nodeEnv: process.env.NODE_ENV || "development",

    // -----------------------------------------------------------------------
    // Server
    // -----------------------------------------------------------------------
    port: parseInt(process.env.PORT, 10) || 3000,

    // -----------------------------------------------------------------------
    // MongoDB
    // -----------------------------------------------------------------------
    mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/rag-chatbot",

    // -----------------------------------------------------------------------
    // LLM Provider — 'ollama' (default) or 'openai'
    // -----------------------------------------------------------------------
    chatProvider: process.env.CHAT_PROVIDER || "ollama",

    // -----------------------------------------------------------------------
    // Ollama — Local LLM
    // -----------------------------------------------------------------------
    ollama: {
        baseUrl: process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
        chatModel: process.env.CHAT_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:7b",
        embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
        contextWindow: parseInt(process.env.OLLAMA_CONTEXT_WINDOW, 10) || 8192,
    },

    // -----------------------------------------------------------------------
    // OpenAI — Only used when CHAT_PROVIDER=openai
    // -----------------------------------------------------------------------
    openai: {
        apiKey: process.env.OPENAI_API_KEY || "",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    },

    // -----------------------------------------------------------------------
    // Embeddings — @xenova/transformers (in-process, no server needed)
    // -----------------------------------------------------------------------
    embedding: {
        model: process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
        dimensions: 384, // all-MiniLM-L6-v2 outputs 384-dim vectors
    },

    // -----------------------------------------------------------------------
    // ChromaDB — Vector Store
    // -----------------------------------------------------------------------
    chroma: {
        url: process.env.CHROMA_URL || "http://localhost:8000",
        collectionName: "conversation_chunks",
    },

    // -----------------------------------------------------------------------
    // Retrieval Tuning
    // -----------------------------------------------------------------------
    retrieval: {
        topK: 5,                     // Number of chunks to retrieve
        similarityThreshold: 0.40,   // Minimum cosine similarity to pass
        slidingWindowSize: 10,       // Recent messages to include in prompt
    },

    // -----------------------------------------------------------------------
    // Chunking Parameters
    // -----------------------------------------------------------------------
    chunking: {
        maxTokens: 500,              // ~500 tokens per chunk
        overlapTokens: 50,           // ~50 token overlap
        separators: ["\n\n", "\n", ". ", " "],
    },

    // -----------------------------------------------------------------------
    // Document Defaults
    // -----------------------------------------------------------------------
    documents: {
        uploadDir: "./uploads",
    },

    // -----------------------------------------------------------------------
    // LLM Generation
    // -----------------------------------------------------------------------
    generation: {
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: 1.1,
    },

    // -----------------------------------------------------------------------
    // Conversation
    // -----------------------------------------------------------------------
    conversation: {
        titleGenerationThreshold: 1,  // Generate title after first exchange
        maxTitleLength: 7,            // Max words in auto-generated title
    },

    // -----------------------------------------------------------------------
    // Metadata Mirror
    // -----------------------------------------------------------------------
    metadataFilePath: process.env.METADATA_FILE_PATH || "./data/chats-metadata.json",
    metadataDebounceMs: 300,

    // -----------------------------------------------------------------------
    // Logging (pino)
    // -----------------------------------------------------------------------
    log: {
        level: process.env.LOG_LEVEL || "info",
    },
};

module.exports = config;
