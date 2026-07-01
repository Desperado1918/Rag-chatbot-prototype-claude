// ============================================================================
// controllers/messageController.js — Message Handling & RAG Orchestration
// ============================================================================
// Orchestrates: save user message → RAG retrieval → stream LLM → save response
// ============================================================================

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { normalizeChunkingMethod } = require("../services/ingestion");
const { askQuestionStream } = require("../../query");
const { maybeGenerateTitle } = require("../services/titleGenerator");
const { maybeSummarizeConversation } = require("../services/conversationSummarizer");
const { indexConversationMemory } = require("../services/memoryManager");
const { logEvent } = require("../services/analytics");
const { invalidateCache } = require("../middleware/cache");

/**
 * Send a message in a conversation and stream the AI response.
 * Uses the existing RAG pipeline via askQuestionStream.
 */
async function sendMessage(req, res) {
    const { id: conversationId } = req.params;
    const userContent = req.body.message?.trim();
    const chunkingMethod = normalizeChunkingMethod(req.body.chunkingMethod);

    if (!userContent) {
        return res.status(400).json({ error: "Message is required" });
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    function writeSse(event, data) {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
        // Verify conversation exists
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            writeSse("error", { error: "Conversation not found" });
            res.end();
            return;
        }

        // Save the user message
        const userMessage = await Message.create({
            conversationId,
            role: "user",
            content: userContent,
        });

        logEvent("message_sent", { conversationId });
        invalidateCache("/api/conversations");

        // Emit the saved user message ID so frontend can track it
        writeSse("user_saved", {
            messageId: userMessage._id,
            createdAt: userMessage.createdAt,
        });

        // Accumulate the full response for saving
        let fullResponse = "";
        let responseSources = [];
        let responseChunkingMethod = chunkingMethod;
        const startTime = Date.now();

        // Stream the RAG response
        await askQuestionStream(
            userContent,
            { chunkingMethod, conversationId },
            {
                onSources: (sources, selectedMethod) => {
                    responseSources = sources || [];
                    responseChunkingMethod = selectedMethod;
                    writeSse("sources", {
                        sources,
                        chunkingMethod: selectedMethod,
                    });
                },
                onToken: (token) => {
                    fullResponse += token;
                    writeSse("token", { token });
                },
                onDone: async () => {
                    try {
                        // Save the assistant message
                        const assistantMessage = await Message.create({
                            conversationId,
                            role: "assistant",
                            content: fullResponse,
                            sources: responseSources,
                            chunkingMethod: responseChunkingMethod,
                        });

                        logEvent("generation_completed", {
                            conversationId,
                            durationMs: Date.now() - startTime,
                        });

                        // Update conversation metadata
                        const preview =
                            fullResponse.length > 150
                                ? fullResponse.slice(0, 150) + "…"
                                : fullResponse;

                        await Conversation.findByIdAndUpdate(conversationId, {
                            messageCount: await Message.countDocuments({
                                conversationId,
                            }),
                            lastMessagePreview: preview,
                        });

                        // Fire-and-forget title generation
                        maybeGenerateTitle(conversationId)
                            .then((title) => {
                                if (title) {
                                    writeSse("title_updated", { title, conversationId });
                                }
                            })
                            .catch(() => {});

                        // Fire-and-forget conversation summarization
                        maybeSummarizeConversation(conversationId).catch(
                            () => {}
                        );

                        // Fire-and-forget semantic memory indexing
                        indexConversationMemory(conversationId).catch(
                            () => {}
                        );

                        invalidateCache("/api/conversations");

                        writeSse("done", {
                            done: true,
                            messageId: assistantMessage._id,
                            createdAt: assistantMessage.createdAt,
                        });
                    } catch (saveError) {
                        console.error(
                            "[messageController] Failed to save response:",
                            saveError
                        );
                        writeSse("done", { done: true });
                    }

                    res.end();
                },
            }
        );
    } catch (error) {
        console.error("[messageController] sendMessage:", error);
        writeSse("error", {
            error: error.message || "Something went wrong",
        });
        res.end();
    }
}

/**
 * Edit a user message (marks it as edited, updates content).
 */
async function editMessage(req, res) {
    try {
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ error: "Content is required" });
        }

        const message = await Message.findById(req.params.messageId);

        if (!message) {
            return res.status(404).json({ error: "Message not found" });
        }

        if (message.role !== "user") {
            return res
                .status(400)
                .json({ error: "Only user messages can be edited" });
        }

        message.content = content.trim();
        message.isEdited = true;
        message.editedAt = new Date();
        await message.save();

        res.json({ message });
    } catch (error) {
        console.error("[messageController] editMessage:", error);
        res.status(500).json({ error: "Failed to edit message" });
    }
}

/**
 * Retry: Delete the last assistant message and re-generate.
 */
async function retryMessage(req, res) {
    try {
        const message = await Message.findById(req.params.messageId);

        if (!message || message.role !== "assistant") {
            return res
                .status(400)
                .json({ error: "Can only retry assistant messages" });
        }

        // Find the preceding user message
        const userMessage = await Message.findOne({
            conversationId: message.conversationId,
            role: "user",
            createdAt: { $lt: message.createdAt },
        })
            .sort({ createdAt: -1 })
            .lean();

        if (!userMessage) {
            return res
                .status(400)
                .json({ error: "No user message found to retry" });
        }

        // Delete the old assistant message
        await Message.findByIdAndDelete(req.params.messageId);

        // Re-route to sendMessage with the original user content
        req.params.id = message.conversationId.toString();
        req.body.message = userMessage.content;
        req.body.chunkingMethod =
            message.chunkingMethod || "hierarchical";

        return sendMessage(req, res);
    } catch (error) {
        console.error("[messageController] retryMessage:", error);
        res.status(500).json({ error: "Failed to retry message" });
    }
}

module.exports = {
    sendMessage,
    editMessage,
    retryMessage,
};
