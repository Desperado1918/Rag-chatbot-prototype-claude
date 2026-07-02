// ============================================================================
// db/connection.js — MongoDB Connection Manager
// ============================================================================
// Handles Mongoose connection lifecycle with in-memory fallback (dev only).
// The memory server is explicitly gated behind NODE_ENV !== 'production'
// and logs a loud, impossible-to-miss warning when it activates.
// ============================================================================

const mongoose = require("mongoose");
const config = require("../config");

let isConnected = false;
let memoryServer = null;
let usingMemoryServer = false;

// -----------------------------------------------------------------------
// Loud warning box — printed when the memory-server fallback activates
// -----------------------------------------------------------------------
const MEMORY_WARNING = `
╔══════════════════════════════════════════════════════════════════════╗
║  ⚠  WARNING: RUNNING ON IN-MEMORY DATABASE — NO PERSISTENCE  ⚠    ║
║                                                                      ║
║  MongoDB was unreachable. The app has fallen back to an ephemeral    ║
║  in-memory database (mongodb-memory-server).                         ║
║                                                                      ║
║  ALL DATA WILL BE LOST when the server restarts.                     ║
║                                                                      ║
║  This is acceptable for development/testing, but NEVER for           ║
║  production. Install MongoDB or start your Docker Compose stack.     ║
╚══════════════════════════════════════════════════════════════════════╝
`;

/**
 * Connect to MongoDB with in-memory fallback (dev only).
 * Designed to be called once at server startup.
 */
async function connectDatabase() {
    if (isConnected) {
        return;
    }

    try {
        await mongoose.connect(config.mongoUri, {
            serverSelectionTimeoutMS: 5000,
            heartbeatFrequencyMS: 10000,
        });

        isConnected = true;
        usingMemoryServer = false;
        console.log(`[MongoDB] Connected to ${config.mongoUri}`);
    } catch (error) {
        console.warn("[MongoDB] Initial connection failed:", error.message);

        // Only allow memory-server fallback in non-production environments
        if (config.nodeEnv === "production") {
            console.error("[MongoDB] FATAL: Cannot use in-memory fallback in production.");
            throw error;
        }

        console.log("[MongoDB] Starting in-memory fallback (dev mode only)...");

        try {
            const { MongoMemoryServer } = require("mongodb-memory-server");
            memoryServer = await MongoMemoryServer.create();
            const memoryUri = memoryServer.getUri();

            await mongoose.connect(memoryUri, {
                serverSelectionTimeoutMS: 5000,
                heartbeatFrequencyMS: 10000,
            });

            isConnected = true;
            usingMemoryServer = true;

            // Print the loud warning
            console.warn(MEMORY_WARNING);
            console.log(`[MongoDB] Connected to in-memory fallback: ${memoryUri}`);
        } catch (fallbackError) {
            console.error("[MongoDB] In-memory fallback also failed:", fallbackError.message);
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
        usingMemoryServer = false;
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

/**
 * Check if the app is running on the in-memory fallback.
 * Used by /api/health and the frontend warning banner.
 */
function isUsingMemoryServer() {
    return usingMemoryServer;
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
    isUsingMemoryServer,
};
