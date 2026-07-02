// ============================================================================
// services/metadataMirror.js — Debounced JSON File Writer
// ============================================================================
// Mirrors chat metadata from MongoDB to a plain JSON file at
// /data/chats-metadata.json. Debounced so rapid updates (e.g., during
// streaming) don't hammer disk I/O.
//
// This file is human-readable — you can open it to see all chats without
// touching the database. MongoDB remains the source of truth.
// ============================================================================

const fs = require("fs");
const path = require("path");
const config = require("../config");

let debounceTimer = null;

/**
 * Queue a metadata sync. Multiple calls within the debounce window
 * are collapsed into a single write.
 */
function syncMetadata() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        await writeMetadataFile();
    }, config.metadataDebounceMs);
}

/**
 * Actually read chats from MongoDB and write the JSON file.
 */
async function writeMetadataFile() {
    try {
        // Lazy-require to avoid circular dependency at module load time
        const Chat = require("../models/Chat");

        const chats = await Chat.find({})
            .select("title createdAt updatedAt messageCount lastMessagePreview isPinned model")
            .sort({ updatedAt: -1 })
            .lean();

        const filePath = path.resolve(config.metadataFilePath);
        const dir = path.dirname(filePath);

        // Ensure the directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const json = JSON.stringify(chats, null, 2);
        fs.writeFileSync(filePath, json, "utf-8");

        console.log(`[MetadataMirror] Wrote ${chats.length} chat(s) to ${filePath}`);
    } catch (error) {
        // Non-fatal — the JSON mirror is a convenience, not a requirement
        console.error("[MetadataMirror] Failed to write metadata file:", error.message);
    }
}

/**
 * Force an immediate sync (bypasses debounce).
 * Useful for testing or shutdown.
 */
async function forceSyncMetadata() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    await writeMetadataFile();
}

module.exports = { syncMetadata, forceSyncMetadata };
