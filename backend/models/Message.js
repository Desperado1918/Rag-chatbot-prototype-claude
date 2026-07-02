// ============================================================================
// models/Message.js — Message Schema
// ============================================================================

const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        chatId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Chat",
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
        retrievedChunkIds: {
            type: [String],
            default: [],
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
messageSchema.index({ chatId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
