// ============================================================================
// services/titleGenerator.js — Auto-Generate Conversation Titles
// ============================================================================
// After 2-3 user messages, calls Ollama to generate a concise 3-5 word title.
// Updates the conversation in MongoDB asynchronously (non-blocking).
// ============================================================================

const axios = require("axios");
const config = require("../config");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

/**
 * Check if a conversation needs a title and generate one if so.
 * Called after each new message is saved.
 *
 * @param {string} conversationId - The conversation to potentially title.
 */
async function maybeGenerateTitle(conversationId) {
    try {
        const conversation = await Conversation.findById(conversationId);

        if (!conversation || conversation.titleGenerated) {
            return; // Already has a generated title
        }

        // Count user messages
        const userMessageCount = await Message.countDocuments({
            conversationId,
            role: "user",
        });

        if (userMessageCount < config.conversation.titleGenerationThreshold) {
            return; // Not enough messages yet
        }

        // Fetch the first few messages for context
        const messages = await Message.find({ conversationId })
            .sort({ createdAt: 1 })
            .limit(6)
            .lean();

        const messageTexts = messages
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join("\n");

        // Generate title via Ollama
        const prompt = `Generate a concise title (3-5 words maximum) for the following conversation. Return ONLY the title, nothing else. No quotes, no punctuation at the end, no explanation.

Conversation:
${messageTexts}

Title:`;

        const response = await axios.post(
            `${config.ollama.baseUrl}/api/generate`,
            {
                model: config.ollama.chatModel,
                prompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 20,
                    num_ctx: 2048,
                },
            }
        );

        let title = (response.data.response || "").trim();

        // Clean up: remove quotes, trailing punctuation, limit to ~5 words
        title = title.replace(/^["']|["']$/g, "").trim();
        title = title.replace(/[.!?]+$/, "").trim();

        const words = title.split(/\s+/);
        if (words.length > config.conversation.maxTitleLength + 2) {
            title = words.slice(0, config.conversation.maxTitleLength).join(" ");
        }

        if (!title || title.length < 3) {
            title = "Chat Conversation";
        }

        // Update the conversation
        await Conversation.findByIdAndUpdate(conversationId, {
            title,
            titleGenerated: true,
        });

        console.log(
            `[TitleGenerator] Generated title for ${conversationId}: "${title}"`
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
