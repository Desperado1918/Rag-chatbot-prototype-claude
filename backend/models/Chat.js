// ============================================================================
// models/Chat.js — Chat Schema (formerly Conversation)
// ============================================================================

const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            default: "New Chat",
            maxlength: 200,
        },
        messageCount: {
            type: Number,
            default: 0,
        },
        lastMessagePreview: {
            type: String,
            default: "",
            maxlength: 200,
        },
        isPinned: {
            type: Boolean,
            default: false,
        },
        isFavorited: {
            type: Boolean,
            default: false,
        },
        model: {
            type: String,
            default: "qwen2.5:7b",
        },
        titleGenerated: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true, // Adds createdAt and updatedAt automatically
    }
);

// Indexes for efficient listing and sorting
chatSchema.index({ updatedAt: -1 });
chatSchema.index({ isPinned: -1, updatedAt: -1 });

module.exports = mongoose.model("Chat", chatSchema);
