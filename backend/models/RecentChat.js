// ============================================================================
// models/RecentChat.js — Recent Chats Schema
// ============================================================================

const mongoose = require("mongoose");

const recentChatSchema = new mongoose.Schema(
    {
        conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        lastAccessedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

module.exports = mongoose.model("RecentChat", recentChatSchema);
