// ============================================================================
// services/analytics.js — Event Logging & Analytics Service
// ============================================================================
// Appends structured JSON events to an append-only log file.
// Used for tracking usage, latencies, and system health over time.
// ============================================================================

const fs = require("fs");
const path = require("path");

const ANALYTICS_DIR = path.join(__dirname, "../../analytics");
const EVENTS_FILE = path.join(ANALYTICS_DIR, "events.jsonl");

// Ensure directory exists
if (!fs.existsSync(ANALYTICS_DIR)) {
    fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
}

/**
 * Log an analytics event to the append-only JSONL file.
 *
 * @param {string} eventName - Type of event (e.g., 'message_sent', 'document_uploaded').
 * @param {Object} data - Metadata associated with the event.
 */
function logEvent(eventName, data = {}) {
    try {
        const event = {
            event: eventName,
            timestamp: new Date().toISOString(),
            ...data,
        };

        const jsonlLine = JSON.stringify(event) + "\n";

        // Non-blocking append
        fs.appendFile(EVENTS_FILE, jsonlLine, (err) => {
            if (err) {
                console.error("[AnalyticsService] Failed to write event:", err.message);
            }
        });
    } catch (err) {
        console.error("[AnalyticsService] Failed to serialize event:", err.message);
    }
}

/**
 * Read the last N events from the JSONL log.
 * (Simple implementation, reads entire file and slices. For production,
 * use a proper stream reader or external log aggregator like ELK).
 *
 * @param {number} [limit=1000] - Max events to return.
 * @returns {Promise<Object[]>}
 */
async function getRecentEvents(limit = 1000) {
    return new Promise((resolve) => {
        fs.readFile(EVENTS_FILE, "utf8", (err, data) => {
            if (err) {
                if (err.code === "ENOENT") return resolve([]);
                console.error("[AnalyticsService] Failed to read events:", err.message);
                return resolve([]);
            }

            const lines = data.split("\n").filter((l) => l.trim().length > 0);
            const start = Math.max(0, lines.length - limit);
            const events = lines.slice(start).map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            }).filter(Boolean);

            resolve(events);
        });
    });
}

/**
 * Get the path to the events JSONL file for CSV export.
 */
function getEventsFilePath() {
    return EVENTS_FILE;
}

module.exports = {
    logEvent,
    getRecentEvents,
    getEventsFilePath,
};
