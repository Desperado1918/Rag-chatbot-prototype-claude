// ============================================================================
// routes/messages.js — Message REST API
// ============================================================================

const { Router } = require("express");
const ctrl = require("../controllers/messageController");

const router = Router();

// Send a message in a conversation (streams AI response via SSE)
router.post("/conversations/:id/messages", ctrl.sendMessage);

// Edit a user message
router.put("/messages/:messageId", ctrl.editMessage);

// Retry an assistant message (regenerate response)
router.post("/messages/:messageId/retry", ctrl.retryMessage);

module.exports = router;
