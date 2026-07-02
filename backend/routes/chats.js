// ============================================================================
// routes/chats.js — Chat Routes (consolidated)
// ============================================================================
// Matches the spec API surface:
//   GET    /api/chats             → listChats
//   POST   /api/chats             → createChat
//   GET    /api/chats/:id         → getChat (+ messages)
//   PATCH  /api/chats/:id         → updateChat (rename/pin)
//   DELETE /api/chats/:id         → deleteChat (cascade)
//   POST   /api/chats/:id/messages → sendMessage (streaming SSE)
// ============================================================================

const express = require("express");
const router = express.Router();

const {
    listChats,
    getChat,
    createChat,
    updateChat,
    deleteChat,
} = require("../controllers/conversationController");

const { sendMessage } = require("../controllers/messageController");

router.get("/", listChats);
router.post("/", createChat);
router.get("/:id", getChat);
router.patch("/:id", updateChat);
router.delete("/:id", deleteChat);
router.post("/:id/messages", sendMessage);

module.exports = router;
