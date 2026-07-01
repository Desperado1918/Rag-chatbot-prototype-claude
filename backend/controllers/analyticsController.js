// ============================================================================
// controllers/analyticsController.js — Analytics Dashboard Aggregation
// ============================================================================

const { getRecentEvents } = require("../services/analytics");
const Conversation = require("../models/Conversation");
const Document = require("../models/Document");
const Message = require("../models/Message");

/**
 * Get aggregated analytics stats for the dashboard.
 */
async function getAnalyticsDashboard(req, res) {
    try {
        // Fetch DB aggregates
        const totalConversations = await Conversation.countDocuments();
        const totalDocuments = await Document.countDocuments();
        const totalMessages = await Message.countDocuments();

        // Fetch events for latency and usage trends
        const events = await getRecentEvents(5000); // Last 5k events

        let totalRetrievalLatency = 0;
        let retrievalCount = 0;
        let totalGenerationLatency = 0;
        let generationCount = 0;
        
        const dailyUsage = {}; // YYYY-MM-DD -> count

        events.forEach((e) => {
            // Latencies
            if (e.event === "retrieval_completed" && e.durationMs) {
                totalRetrievalLatency += e.durationMs;
                retrievalCount++;
            }
            if (e.event === "generation_completed" && e.durationMs) {
                totalGenerationLatency += e.durationMs;
                generationCount++;
            }

            // Daily usage
            if (e.event === "message_sent" && e.timestamp) {
                const date = e.timestamp.split("T")[0];
                dailyUsage[date] = (dailyUsage[date] || 0) + 1;
            }
        });

        const avgRetrievalLatency = retrievalCount > 0 ? totalRetrievalLatency / retrievalCount : 0;
        const avgGenerationLatency = generationCount > 0 ? totalGenerationLatency / generationCount : 0;

        res.json({
            overview: {
                totalConversations,
                totalDocuments,
                totalMessages,
                avgRetrievalLatencyMs: Math.round(avgRetrievalLatency),
                avgGenerationLatencyMs: Math.round(avgGenerationLatency),
            },
            dailyUsage,
        });
    } catch (error) {
        console.error("[AnalyticsController] Dashboard error:", error);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
}

/**
 * Export raw JSONL events as a file.
 */
async function exportEvents(req, res) {
    try {
        const { getEventsFilePath } = require("../services/analytics");
        const filePath = getEventsFilePath();
        
        const fs = require("fs");
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "No events log found" });
        }

        res.download(filePath, `analytics_export_${Date.now()}.jsonl`);
    } catch (error) {
        console.error("[AnalyticsController] Export error:", error);
        res.status(500).json({ error: "Failed to export analytics" });
    }
}

module.exports = {
    getAnalyticsDashboard,
    exportEvents,
};
