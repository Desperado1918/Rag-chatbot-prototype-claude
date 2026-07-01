// ============================================================================
// models/Metadata.js — Metadata Schema
// ============================================================================

const mongoose = require("mongoose");

const metadataSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, index: true },
        value: { type: mongoose.Schema.Types.Mixed, required: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Metadata", metadataSchema);
