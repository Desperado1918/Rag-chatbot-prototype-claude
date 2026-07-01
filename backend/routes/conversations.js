// ============================================================================
// routes/conversations.js — Conversation REST API
// ============================================================================

const { Router } = require("express");
const ctrl = require("../controllers/conversationController");
const { cacheMiddleware } = require("../middleware/cache");

const router = Router();

// List all conversations (paginated, searchable)
router.get("/", cacheMiddleware(10000), ctrl.listConversations);

// Get a single conversation with full messages
router.get("/:id", cacheMiddleware(30000), ctrl.getConversation);

// Create a new conversation
router.post("/", ctrl.createConversation);

// Delete a conversation
router.delete("/:id", ctrl.deleteConversation);

// Rename a conversation
router.put("/:id/title", ctrl.renameConversation);

// Toggle pin
router.put("/:id/pin", ctrl.togglePin);

// Toggle favorite
router.put("/:id/favorite", ctrl.toggleFavorite);

// Toggle archive
router.put("/:id/archive", ctrl.toggleArchive);

module.exports = router;
