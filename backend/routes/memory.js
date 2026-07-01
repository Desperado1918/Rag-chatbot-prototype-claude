// ============================================================================
// routes/memory.js — Memory API
// ============================================================================

const { Router } = require("express");
const { searchMemory, indexConversationMemory } = require("../services/memoryManager");

const router = Router();

// Search conversation memory
router.post("/search", async (req, res) => {
    try {
        const { query, excludeConversationId, nResults } = req.body;

        if (!query) {
            return res.status(400).json({ error: "Query is required" });
        }

        const results = await searchMemory(query, {
            nResults: nResults || 5,
            excludeConversationId,
        });

        res.json({ results });
    } catch (error) {
        console.error("[MemoryRoute] search error:", error);
        res.status(500).json({ error: "Failed to search memory" });
    }
});

// Manually trigger memory indexing for a conversation
router.post("/index", async (req, res) => {
    try {
        const { conversationId } = req.body;

        if (!conversationId) {
            return res.status(400).json({ error: "conversationId is required" });
        }

        const result = await indexConversationMemory(conversationId);
        res.json(result);
    } catch (error) {
        console.error("[MemoryRoute] index error:", error);
        res.status(500).json({ error: "Failed to index memory" });
    }
});

module.exports = router;
