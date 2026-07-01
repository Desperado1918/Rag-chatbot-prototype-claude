// ============================================================================
// models/Document.js — Uploaded Document Schema
// ============================================================================

const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema(
    {
        filename: {
            type: String,
            required: true,
        },
        originalName: {
            type: String,
            required: true,
        },
        filepath: {
            type: String,
            required: true,
        },
        conversationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
            default: null,
            index: true,
        },
        embeddingStatus: {
            type: String,
            enum: ["pending", "processing", "completed", "failed"],
            default: "pending",
        },
        chunkCount: {
            type: Number,
            default: 0,
        },
        chunkingMethod: {
            type: String,
            default: "hierarchical",
        },
        collectionName: {
            type: String,
            default: null,
        },
        fileSize: {
            type: Number,
            default: 0,
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Document", documentSchema);
