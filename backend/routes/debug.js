// ============================================================================
// routes/debug.js — Debug Routes
// ============================================================================

const express = require("express");
const router = express.Router();
const { getChunks } = require("../controllers/debugController");

// GET /api/debug/chunks/:chatId
router.get("/chunks/:chatId", getChunks);

module.exports = router;
