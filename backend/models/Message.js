// ============================================================================
// models/Message.js — Message Schema
// ============================================================================

const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
            index: true,
        },
        role: {
            type: String,
            enum: ["user", "assistant", "system"],
            required: true,
        },
        content: {
            type: String,
            required: true,
        },
        sources: [
            {
                source: String,
                chunkingMethod: String,
                chunkNumber: Number,
                parentId: String,
                parentNumber: Number,
                matchedChildNumber: Number,
                similarity: Number,
                text: String,
            },
        ],
        chunkingMethod: {
            type: String,
            default: null,
        },
        tokenCount: {
            type: Number,
            default: 0,
        },
        isEdited: {
            type: Boolean,
            default: false,
        },
        editedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for fetching messages in a conversation efficiently
messageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
