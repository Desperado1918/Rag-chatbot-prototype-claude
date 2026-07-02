// ============================================================================
// controllers/searchController.js — Chat History Search
// ============================================================================
// GET /api/search?q=query
// Searches across chat history using MongoDB text search on message content.
// ============================================================================

const Message = require("../models/Message");
const Chat = require("../models/Chat");
const { createServiceError } = require("../utils/errors");

/**
 * Search across chat history.
 *
 * Query params: q (required), limit (optional, default 20)
 * Response: { results: Array<{ chat, matchingMessages }> }
 */
async function searchChats(req, res) {
    const query = req.query.q;

    if (!query || !query.trim()) {
        throw createServiceError("Search query 'q' is required", 400);
    }

    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

    // Use regex search on message content (MongoDB text search requires a text index)
    const messages = await Message.find({
        content: { $regex: query.trim(), $options: "i" },
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    // Group by chatId and fetch chat metadata
    const chatIds = [...new Set(messages.map((m) => m.chatId.toString()))];
    const chats = await Chat.find({ _id: { $in: chatIds } }).lean();
    const chatMap = new Map(chats.map((c) => [c._id.toString(), c]));

    const results = chatIds.map((chatId) => ({
        chat: chatMap.get(chatId) || { _id: chatId, title: "Unknown" },
        matchingMessages: messages
            .filter((m) => m.chatId.toString() === chatId)
            .map((m) => ({
                _id: m._id,
                role: m.role,
                content: m.content.slice(0, 200), // Preview only
                createdAt: m.createdAt,
            })),
    }));

    res.json({
        query: query.trim(),
        totalResults: messages.length,
        results,
    });
}

module.exports = { searchChats };
