// ============================================================================
// models/Favorite.js — Favorites Schema
// ============================================================================

const mongoose = require("mongoose");

const favoriteSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Favorite", favoriteSchema);
