// ============================================================================
// services/chatService.js — Per-Message Orchestrator
// ============================================================================
// Implements the full per-message flow from the spec (Section 4):
//   1. Save user message to MongoDB
//   2. Embed query → search ChromaDB → get top-k context
//   3. Build prompt (system + context + sliding window + new message)
//   4. Stream LLM response, relay tokens
//   5. Save assistant message to MongoDB
//   6. Async: chunk turn → embed → store in ChromaDB
//   7. Update chat metadata + trigger metadata mirror
//   8. Maybe generate title
// ============================================================================

const Chat = require("../models/Chat");
const Message = require("../models/Message");
const { streamChat } = require("./llmService");
const { searchSimilar, storeChunks } = require("./vectorService");
const { chunkConversationTurn } = require("./chunkingService");
const { syncMetadata } = require("./metadataMirror");
const { maybeGenerateTitle } = require("./titleGenerator");
const { performHybridDualRetrieval } = require("./hybridRetrieval");
const config = require("../config");

/**
 * Handle a new user message: save, retrieve context, stream response,
 * then async-store the turn in the vector DB.
 *
 * @param {string} chatId - The chat ID.
 * @param {string} userContent - The user's message text.
 * @param {Object} handlers - { onToken, onSources, onDone, onError }
 * @param {string} chunkingMethod - "standard" or "hierarchical".
 * @returns {Promise<Object>} - { userMessage, assistantMessage, chunkIds }
 */
async function handleMessage(chatId, userContent, handlers = {}, chunkingMethod = "hierarchical") {
    // -----------------------------------------------------------------------
    // Step 1: Save user message to MongoDB immediately
    // -----------------------------------------------------------------------
    const userMessage = await Message.create({
        chatId,
        role: "user",
        content: userContent,
    });

    // -----------------------------------------------------------------------
    // Step 2: Embed query and search ChromaDB for relevant past context
    // -----------------------------------------------------------------------
    let retrievedChunks = [];
    let retrievedChunkIds = [];
    let conversationContext = "";

    try {
        const retrievalResult = await performHybridDualRetrieval(userContent, {
            chunkingMethod,
            conversationId: chatId,
        });

        retrievedChunks = retrievalResult.contextChunks || [];
        retrievedChunkIds = retrievedChunks.map((c) => c.id).filter(Boolean);
        conversationContext = retrievalResult.conversationContext || "";

        // Notify frontend about retrieved sources
        if (retrievedChunks.length > 0) {
            handlers.onSources?.(retrievedChunks);
        }
    } catch (error) {
        // RAG failure is non-fatal — continue without context
        console.warn("[ChatService] RAG retrieval failed:", error.message);
    }

    // -----------------------------------------------------------------------
    // Step 3: Build prompt — system + retrieved context + sliding window
    // -----------------------------------------------------------------------
    const recentMessages = await Message.find({ chatId })
        .sort({ createdAt: -1 })
        .limit(config.retrieval.slidingWindowSize)
        .lean();

    // Reverse to chronological order
    recentMessages.reverse();

    const messages = buildPromptMessages(recentMessages, retrievedChunks, conversationContext);

    // -----------------------------------------------------------------------
    // Step 4: Stream LLM response
    // -----------------------------------------------------------------------
    let fullResponse = "";

    try {
        fullResponse = await streamChat(messages, {}, {
            onToken: (token) => {
                handlers.onToken?.(token);
            },
            onDone: () => {
                // onDone is called after the full response is assembled
            },
        });
    } catch (error) {
        handlers.onError?.(error);
        throw error;
    }

    // -----------------------------------------------------------------------
    // Step 5: Save assistant message to MongoDB
    // -----------------------------------------------------------------------
    const assistantMessage = await Message.create({
        chatId,
        role: "assistant",
        content: fullResponse,
        retrievedChunkIds,
    });

    // -----------------------------------------------------------------------
    // Step 6 (async): Chunk the turn → embed → store in ChromaDB
    // -----------------------------------------------------------------------
    setImmediate(async () => {
        try {
            const textChunks = chunkConversationTurn(userContent, fullResponse);

            const chunkObjects = textChunks.map((text, index) => ({
                text,
                chatId,
                messageIds: [userMessage._id.toString(), assistantMessage._id.toString()],
                chunkIndex: index,
                source: "conversation",
            }));

            await storeChunks(chunkObjects);
        } catch (error) {
            console.error("[ChatService] Failed to store conversation chunks:", error.message);
        }
    });

    // -----------------------------------------------------------------------
    // Step 7: Update chat metadata + trigger metadata mirror
    // -----------------------------------------------------------------------
    const preview = userContent.slice(0, 80);
    const messageCount = await Message.countDocuments({ chatId });

    await Chat.findByIdAndUpdate(chatId, {
        messageCount,
        lastMessagePreview: preview,
        updatedAt: new Date(),
    });

    syncMetadata();

    // -----------------------------------------------------------------------
    // Step 8: Maybe generate title (async, non-blocking)
    // -----------------------------------------------------------------------
    setImmediate(() => {
        maybeGenerateTitle(chatId).catch((err) => {
            console.error("[ChatService] Title generation failed:", err.message);
        });
    });

    handlers.onDone?.();

    return {
        userMessage,
        assistantMessage,
        retrievedChunkIds,
    };
}

/**
 * Build the messages array for the LLM, including system prompt,
 * retrieved RAG context, and the sliding window of recent messages.
 */
function buildPromptMessages(recentMessages, retrievedChunks, conversationContext = "") {
    const messages = [];

    // System prompt
    let systemContent = `You are a helpful, accurate assistant. Answer questions thoughtfully and cite sources when relevant context is provided.`;

    if (conversationContext) {
        systemContent += `\n\n${conversationContext}`;
    }

    // Append retrieved context to system prompt if available
    if (retrievedChunks.length > 0) {
        const contextBlock = retrievedChunks
            .map((chunk, i) => `[Context ${i + 1}]\n${chunk.text}`)
            .join("\n\n---\n\n");

        systemContent += `\n\nThe following is relevant context retrieved from past conversations and documents. Use it to inform your answer, but don't fabricate information not present in the context or your knowledge:\n\n${contextBlock}`;
    }

    messages.push({ role: "system", content: systemContent });

    // Sliding window of recent messages
    for (const msg of recentMessages) {
        messages.push({
            role: msg.role,
            content: msg.content,
        });
    }

    return messages;
}

module.exports = { handleMessage, buildPromptMessages };
