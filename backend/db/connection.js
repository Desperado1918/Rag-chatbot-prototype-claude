// ============================================================================
// db/connection.js — MongoDB Connection Manager
// ============================================================================
// Handles Mongoose connection lifecycle with retry logic and graceful shutdown.
// ============================================================================

const mongoose = require("mongoose");
const config = require("../config");
const { MongoMemoryServer } = require("mongodb-memory-server");

let isConnected = false;
let memoryServer = null;

/**
 * Connect to MongoDB with in-memory fallback.
 * Designed to be called once at server startup.
 */
async function connectDatabase() {
    if (isConnected) {
        console.log("[MongoDB] Already connected.");
        return;
    }

    try {
        await mongoose.connect(config.mongoUri, {
            serverSelectionTimeoutMS: 5000,
            heartbeatFrequencyMS: 10000,
        });

        isConnected = true;
        console.log(`[MongoDB] Connected to ${config.mongoUri}`);
    } catch (error) {
        console.warn("[MongoDB] Initial connection failed:", error.message);
        console.log("[MongoDB] Starting in-memory fallback server (running without persistence)...");
        
        try {
            memoryServer = await MongoMemoryServer.create();
            const memoryUri = memoryServer.getUri();
            
            await mongoose.connect(memoryUri, {
                serverSelectionTimeoutMS: 5000,
                heartbeatFrequencyMS: 10000,
            });
            
            isConnected = true;
            console.log(`[MongoDB] Connected to in-memory fallback: ${memoryUri}`);
        } catch (fallbackError) {
            console.error("[MongoDB] In-memory fallback failed:", fallbackError.message);
            throw fallbackError;
        }
    }

    // Handle connection events
    mongoose.connection.on("error", (err) => {
        console.error("[MongoDB] Connection error:", err.message);
    });

    mongoose.connection.on("disconnected", () => {
        isConnected = false;
        console.warn("[MongoDB] Disconnected.");
    });

    mongoose.connection.on("reconnected", () => {
        isConnected = true;
        console.log("[MongoDB] Reconnected.");
    });
}

/**
 * Gracefully close the MongoDB connection.
 * Called during server shutdown.
 */
async function disconnectDatabase() {
    if (!isConnected) return;
    try {
        await mongoose.disconnect();
        if (memoryServer) {
            await memoryServer.stop();
            memoryServer = null;
        }
        isConnected = false;
        console.log("[MongoDB] Disconnected gracefully.");
    } catch (error) {
        console.error("[MongoDB] Disconnect error:", error.message);
    }
}

/**
 * Get the current connection status.
 */
function isDatabaseConnected() {
    return isConnected && mongoose.connection.readyState === 1;
}

// Handle process termination gracefully
process.on("SIGINT", async () => {
    await disconnectDatabase();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await disconnectDatabase();
    process.exit(0);
});

module.exports = {
    connectDatabase,
    disconnectDatabase,
    isDatabaseConnected,
};
