// ============================================================================
// services/titleGenerator.js — Auto-Generate Chat Titles
// ============================================================================
// After the first user+assistant exchange, calls the LLM to generate a
// concise 3-7 word title. Updates the chat in MongoDB asynchronously.
// ============================================================================

const Chat = require("../models/Chat");
const Message = require("../models/Message");
const { generateCompletion } = require("./llmService");
const config = require("../config");
const { syncMetadata } = require("./metadataMirror");

/**
 * Check if a chat needs a title and generate one if so.
 * Called after each new message is saved.
 *
 * @param {string} chatId - The chat to potentially title.
 * @returns {Promise<string|null>} - The generated title, or null.
 */
async function maybeGenerateTitle(chatId) {
    try {
        const chat = await Chat.findById(chatId);

        if (!chat || chat.titleGenerated) {
            return null; // Already has a generated title
        }

        // Count user messages
        const userMessageCount = await Message.countDocuments({
            chatId,
            role: "user",
        });

        if (userMessageCount < config.conversation.titleGenerationThreshold) {
            return null; // Not enough messages yet
        }

        // Fetch the first few messages for context
        const messages = await Message.find({ chatId })
            .sort({ createdAt: 1 })
            .limit(6)
            .lean();

        const messageTexts = messages
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join("\n");

        // Generate title via LLM
        const prompt = `Generate a concise title (3-7 words maximum) for the following conversation. Return ONLY the title, nothing else. No quotes, no punctuation at the end, no explanation.\n\nConversation:\n${messageTexts}\n\nTitle:`;

        let title = await generateCompletion(prompt, {
            temperature: 0.3,
            maxTokens: 20,
        });

        // Clean up: remove quotes, trailing punctuation, limit words
        title = title.replace(/^["']|["']$/g, "").trim();
        title = title.replace(/[.!?]+$/, "").trim();

        const words = title.split(/\s+/);
        if (words.length > config.conversation.maxTitleLength + 2) {
            title = words.slice(0, config.conversation.maxTitleLength).join(" ");
        }

        if (!title || title.length < 3) {
            // Fallback: truncate the first user message
            const firstUserMsg = messages.find((m) => m.role === "user");
            title = firstUserMsg
                ? firstUserMsg.content.slice(0, 40).trim()
                : "Chat Conversation";
        }

        // Update the chat
        await Chat.findByIdAndUpdate(chatId, {
            title,
            titleGenerated: true,
        });

        syncMetadata();

        console.log(
            `[TitleGenerator] Generated title for ${chatId}: "${title}"`
        );

        return title;
    } catch (error) {
        console.error(
            "[TitleGenerator] Failed to generate title:",
            error.message
        );
        // Non-fatal — conversation continues without a generated title
        return null;
    }
}

module.exports = { maybeGenerateTitle };
