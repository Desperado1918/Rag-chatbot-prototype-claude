// ============================================================================
// controllers/conversationController.js — Conversation CRUD
// ============================================================================

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { invalidateCache } = require("../middleware/cache");

/**
 * List all conversations (lightweight — title, preview, timestamps only).
 * Supports pagination and filtering.
 */
async function listConversations(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 30);
        const skip = (page - 1) * limit;

        const filter = { isArchived: false, messageCount: { $gt: 0 } };

        // Optional search by title
        if (req.query.search) {
            filter.title = { $regex: req.query.search, $options: "i" };
        }

        const [conversations, total] = await Promise.all([
            Conversation.find(filter)
                .select("title lastMessagePreview messageCount isPinned isFavorited createdAt updatedAt")
                .sort({ isPinned: -1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Conversation.countDocuments(filter),
        ]);

        res.json({
            conversations,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("[conversationController] listConversations:", error);
        res.status(500).json({ error: "Failed to list conversations" });
    }
}

/**
 * Get a single conversation with its full message history.
 */
async function getConversation(req, res) {
    try {
        const conversation = await Conversation.findById(
            req.params.id
        ).lean();

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        const messages = await Message.find({
            conversationId: req.params.id,
        })
            .sort({ createdAt: 1 })
            .lean();

        res.json({ conversation, messages });
    } catch (error) {
        console.error("[conversationController] getConversation:", error);
        res.status(500).json({ error: "Failed to load conversation" });
    }
}

/**
 * Create a new empty conversation.
 */
async function createConversation(req, res) {
    try {
        const conversation = await Conversation.create({
            title: req.body.title || "New Conversation",
        });

        invalidateCache("/api/conversations");
        res.status(201).json({ conversation });
    } catch (error) {
        console.error("[conversationController] createConversation:", error);
        res.status(500).json({ error: "Failed to create conversation" });
    }
}

/**
 * Delete a conversation and all its messages.
 */
async function deleteConversation(req, res) {
    try {
        const conversation = await Conversation.findByIdAndDelete(
            req.params.id
        );

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        // Cascade delete all messages
        await Message.deleteMany({ conversationId: req.params.id });

        invalidateCache("/api/conversations");
        res.json({ success: true, deletedId: req.params.id });
    } catch (error) {
        console.error("[conversationController] deleteConversation:", error);
        res.status(500).json({ error: "Failed to delete conversation" });
    }
}

/**
 * Rename a conversation.
 */
async function renameConversation(req, res) {
    try {
        const { title } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: "Title is required" });
        }

        const conversation = await Conversation.findByIdAndUpdate(
            req.params.id,
            { title: title.trim() },
            { new: true }
        ).lean();

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        invalidateCache("/api/conversations");
        res.json({ conversation });
    } catch (error) {
        console.error("[conversationController] renameConversation:", error);
        res.status(500).json({ error: "Failed to rename conversation" });
    }
}

/**
 * Toggle pin status.
 */
async function togglePin(req, res) {
    try {
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        conversation.isPinned = !conversation.isPinned;
        await conversation.save();

        invalidateCache("/api/conversations");
        res.json({ conversation });
    } catch (error) {
        console.error("[conversationController] togglePin:", error);
        res.status(500).json({ error: "Failed to toggle pin" });
    }
}

/**
 * Toggle favorite status.
 */
async function toggleFavorite(req, res) {
    try {
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        conversation.isFavorited = !conversation.isFavorited;
        await conversation.save();

        invalidateCache("/api/conversations");
        res.json({ conversation });
    } catch (error) {
        console.error("[conversationController] toggleFavorite:", error);
        res.status(500).json({ error: "Failed to toggle favorite" });
    }
}

/**
 * Toggle archive status.
 */
async function toggleArchive(req, res) {
    try {
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        conversation.isArchived = !conversation.isArchived;
        conversation.status = conversation.isArchived ? "archived" : "active";
        await conversation.save();

        invalidateCache("/api/conversations");
        res.json({ conversation });
    } catch (error) {
        console.error("[conversationController] toggleArchive:", error);
        res.status(500).json({ error: "Failed to toggle archive" });
    }
}

module.exports = {
    listConversations,
    getConversation,
    createConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    toggleFavorite,
    toggleArchive,
};
