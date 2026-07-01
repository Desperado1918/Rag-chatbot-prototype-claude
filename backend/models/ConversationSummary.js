// ============================================================================
// models/ConversationSummary.js — Conversation Summary Schema
// ============================================================================
// Stores LLM-generated summaries of long conversations to reduce token usage.
// When a conversation exceeds the summary threshold, older messages are
// summarized and this summary is used instead of the full message history.
// ============================================================================

const mongoose = require("mongoose");

const conversationSummarySchema = new mongoose.Schema(
    {
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
            index: true,
        },
        summary: {
            type: String,
            required: true,
        },
        messageRange: {
            start: { type: Number, required: true },  // Message index start
            end: { type: Number, required: true },     // Message index end
        },
        messageCount: {
            type: Number,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model(
    "ConversationSummary",
    conversationSummarySchema
);
