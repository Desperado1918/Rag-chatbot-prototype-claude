// ============================================================================
// routes/search.js — Search Routes
// ============================================================================

const express = require("express");
const router = express.Router();
const { searchChats } = require("../controllers/searchController");

// GET /api/search?q=query
router.get("/", searchChats);

module.exports = router;
