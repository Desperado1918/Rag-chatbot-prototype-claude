// ============================================================================
// controllers/messageController.js — Message Controller (Streaming & REST)
// ============================================================================

const Chat = require("../models/Chat");
const Message = require("../models/Message");
const { handleMessage, buildPromptMessages } = require("../services/chatService");
const { streamChat } = require("../services/llmService");
const { performHybridDualRetrieval } = require("../services/hybridRetrieval");
const { syncMetadata } = require("../services/metadataMirror");
const { createServiceError } = require("../utils/errors");
const config = require("../config");

/**
 * Send a message to a chat and stream the response.
 *
 * Request body: { content: string, chunkingMethod: string }
 * Response: Server-Sent Events stream
 */
async function sendMessage(req, res) {
    const chatId = req.params.id;
    const { content, chunkingMethod } = req.body;

    // Verify chat exists
    const chat = await Chat.findById(chatId);
    if (!chat) {
        throw createServiceError("Chat not found", 404);
    }

    if (!content || !content.trim()) {
        throw createServiceError("Message content is required", 400);
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders?.();

    // Track if the client disconnected
    let clientDisconnected = false;
    req.on("close", () => {
        clientDisconnected = true;
    });

    function writeSse(data) {
        if (clientDisconnected) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
        const result = await handleMessage(chatId, content.trim(), {
            onToken: (token) => {
                writeSse({ type: "token", token });
            },
            onSources: (sources) => {
                writeSse({
                    type: "sources",
                    sources: sources.map((s) => ({
                        id: s.id,
                        text: s.text,
                        similarity: s.similarity,
                        metadata: s.metadata,
                    })),
                });
            },
            onDone: () => {},
            onError: (error) => {
                writeSse({ type: "error", error: error.message });
            },
        }, chunkingMethod);

        // Send done event with the saved message IDs
        writeSse({
            type: "done",
            userMessage: {
                _id: result.userMessage._id,
                chatId: result.userMessage.chatId,
                role: "user",
                content: result.userMessage.content,
                createdAt: result.userMessage.createdAt,
            },
            assistantMessage: {
                _id: result.assistantMessage._id,
                chatId: result.assistantMessage.chatId,
                role: "assistant",
                content: result.assistantMessage.content,
                retrievedChunkIds: result.retrievedChunkIds,
                createdAt: result.assistantMessage.createdAt,
            },
        });

        res.end();
    } catch (error) {
        console.error("[MessageController] Stream error:", error.message);
        writeSse({ type: "error", error: error.message || "Stream failed" });
        res.end();
    }
}

/**
 * Edit a user message and delete all subsequent messages in the conversation.
 * Also re-indexes remaining turns in the vector store.
 *
 * PUT /api/messages/:messageId
 */
async function editMessage(req, res) {
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
        throw createServiceError("Content is required", 400);
    }

    const userMsg = await Message.findById(messageId);
    if (!userMsg) {
        throw createServiceError("Message not found", 404);
    }

    // Update user message content
    userMsg.content = content.trim();
    userMsg.isEdited = true;
    userMsg.editedAt = new Date();
    await userMsg.save();

    // Delete all subsequent messages in this chat
    await Message.deleteMany({
        chatId: userMsg.chatId,
        createdAt: { $gt: userMsg.createdAt },
    });

    // Re-index remaining conversation turns in ChromaDB
    const chatIdStr = userMsg.chatId.toString();
    try {
        const { deleteByChat, storeChunks } = require("../services/vectorService");
        const { chunkConversationTurn } = require("../services/chunkingService");

        await deleteByChat(chatIdStr);

        const remainingMessages = await Message.find({ chatId: userMsg.chatId })
            .sort({ createdAt: 1 })
            .lean();

        const chunkObjects = [];
        for (let i = 0; i < remainingMessages.length; i++) {
            const msg = remainingMessages[i];
            if (msg.role === "user" && remainingMessages[i + 1] && remainingMessages[i + 1].role === "assistant") {
                const userText = msg.content;
                const assistantText = remainingMessages[i + 1].content;
                const textChunks = chunkConversationTurn(userText, assistantText);

                textChunks.forEach((text, index) => {
                    chunkObjects.push({
                        text,
                        chatId: chatIdStr,
                        messageIds: [msg._id.toString(), remainingMessages[i + 1]._id.toString()],
                        chunkIndex: index,
                        source: "conversation",
                    });
                });
            }
        }

        if (chunkObjects.length > 0) {
            await storeChunks(chunkObjects);
        }
    } catch (err) {
        console.error("[MessageController] Failed to re-index during edit:", err.message);
    }

    // Update chat preview metadata
    const preview = userMsg.content.slice(0, 80);
    const messageCount = await Message.countDocuments({ chatId: userMsg.chatId });
    await Chat.findByIdAndUpdate(userMsg.chatId, {
        messageCount,
        lastMessagePreview: preview,
        updatedAt: new Date(),
    });

    syncMetadata();

    res.json({
        status: "success",
        message: "Message updated and subsequent history cleared.",
    });
}

/**
 * Regenerate assistant response (retry message).
 * Deletes target assistant message and regenerates using preceding user message.
 *
 * POST /api/messages/:messageId/retry
 */
async function retryMessage(req, res) {
    const { messageId } = req.params;
    const { chunkingMethod } = req.body;

    const assistantMsg = await Message.findById(messageId);
    if (!assistantMsg) {
        throw createServiceError("Message not found", 404);
    }

    const chatIdStr = assistantMsg.chatId.toString();

    // Find preceding user message
    const userMsg = await Message.findOne({
        chatId: assistantMsg.chatId,
        createdAt: { $lt: assistantMsg.createdAt },
        role: "user",
    }).sort({ createdAt: -1 });

    if (!userMsg) {
        throw createServiceError("No preceding user message found to retry", 404);
    }

    // Delete assistant message and any subsequent messages (just in case)
    await Message.deleteMany({
        chatId: assistantMsg.chatId,
        createdAt: { $gte: assistantMsg.createdAt },
    });

    // Re-index remaining conversation in ChromaDB
    try {
        const { deleteByChat, storeChunks } = require("../services/vectorService");
        const { chunkConversationTurn } = require("../services/chunkingService");

        await deleteByChat(chatIdStr);

        const remainingMessages = await Message.find({ chatId: assistantMsg.chatId })
            .sort({ createdAt: 1 })
            .lean();

        const chunkObjects = [];
        for (let i = 0; i < remainingMessages.length; i++) {
            const msg = remainingMessages[i];
            if (msg.role === "user" && remainingMessages[i + 1] && remainingMessages[i + 1].role === "assistant") {
                const userText = msg.content;
                const assistantText = remainingMessages[i + 1].content;
                const textChunks = chunkConversationTurn(userText, assistantText);

                textChunks.forEach((text, index) => {
                    chunkObjects.push({
                        text,
                        chatId: chatIdStr,
                        messageIds: [msg._id.toString(), remainingMessages[i + 1]._id.toString()],
                        chunkIndex: index,
                        source: "conversation",
                    });
                });
            }
        }

        if (chunkObjects.length > 0) {
            await storeChunks(chunkObjects);
        }
    } catch (err) {
        console.error("[MessageController] Failed to re-index during retry:", err.message);
    }

    // Retrieve context for userMsg
    let retrievedChunks = [];
    let retrievedChunkIds = [];
    let conversationContext = "";

    try {
        const retrievalResult = await performHybridDualRetrieval(userMsg.content, {
            chunkingMethod: chunkingMethod || "hierarchical",
            conversationId: chatIdStr,
        });

        retrievedChunks = retrievalResult.contextChunks || [];
        retrievedChunkIds = retrievedChunks.map((c) => c.id).filter(Boolean);
        conversationContext = retrievalResult.conversationContext || "";
    } catch (error) {
        console.warn("[MessageController] RAG retrieval failed during retry:", error.message);
    }

    // Build LLM messages
    const recentMessages = await Message.find({ chatId: assistantMsg.chatId })
        .sort({ createdAt: -1 })
        .limit(config.retrieval.slidingWindowSize)
        .lean();

    recentMessages.reverse();

    const messages = buildPromptMessages(recentMessages, retrievedChunks, conversationContext);

    // Call LLM (synchronous response as frontend expects block fetch resolution)
    let fullResponse = "";
    try {
        fullResponse = await streamChat(messages, {}, {});
    } catch (error) {
        throw createServiceError(`LLM generation failed: ${error.message}`, 500);
    }

    // Save new assistant message
    const newAssistantMsg = await Message.create({
        chatId: assistantMsg.chatId,
        role: "assistant",
        content: fullResponse,
        retrievedChunkIds,
    });

    // Chunk the new turn and store in ChromaDB (async)
    setImmediate(async () => {
        try {
            const { storeChunks } = require("../services/vectorService");
            const { chunkConversationTurn } = require("../services/chunkingService");

            const textChunks = chunkConversationTurn(userMsg.content, fullResponse);

            const chunkObjects = textChunks.map((text, index) => ({
                text,
                chatId: chatIdStr,
                messageIds: [userMsg._id.toString(), newAssistantMsg._id.toString()],
                chunkIndex: index,
                source: "conversation",
            }));

            await storeChunks(chunkObjects);
        } catch (error) {
            console.error("[MessageController] Failed to store conversation chunks on retry:", error.message);
        }
    });

    // Update Chat message count
    const messageCount = await Message.countDocuments({ chatId: assistantMsg.chatId });
    await Chat.findByIdAndUpdate(assistantMsg.chatId, {
        messageCount,
        updatedAt: new Date(),
    });

    syncMetadata();

    res.json({
        status: "success",
        message: "Message regenerated successfully.",
        assistantMessage: newAssistantMsg,
    });
}

module.exports = {
    sendMessage,
    editMessage,
    retryMessage,
};
