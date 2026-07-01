// ============================================================================
// models/Conversation.js — Conversation Schema
// ============================================================================

const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            default: "New Conversation",
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
        status: {
            type: String,
            enum: ["active", "archived"],
            default: "active",
        },
        isPinned: {
            type: Boolean,
            default: false,
        },
        isFavorited: {
            type: Boolean,
            default: false,
        },
        isArchived: {
            type: Boolean,
            default: false,
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

// Index for efficient listing and sorting
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ isPinned: -1, updatedAt: -1 });
conversationSchema.index({ isFavorited: 1 });
conversationSchema.index({ isArchived: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
