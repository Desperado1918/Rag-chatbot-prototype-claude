// ============================================================================
// services/conversationSummarizer.js — Conversation Summary Generation
// ============================================================================
// When a conversation exceeds a configurable message threshold, generates an
// LLM summary of older messages. Future prompts use the summary + recent
// messages instead of the full history, reducing token usage significantly.
// ============================================================================

const axios = require("axios");
const config = require("../config");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const ConversationSummary = require("../models/ConversationSummary");

/**
 * Check if a conversation needs summarization and generate a summary if so.
 * Called after each new message is saved (non-blocking / fire-and-forget).
 *
 * Strategy:
 *   - Trigger when message count exceeds config.conversation.summaryThreshold
 *   - Summarize all messages except the most recent N (keeps recent context fresh)
 *   - Store summary in ConversationSummary collection
 *   - On subsequent queries, prepend summary + last N messages instead of full history
 *
 * @param {string} conversationId - The conversation to potentially summarize.
 * @returns {Promise<string|null>} - The generated summary, or null if not needed.
 */
async function maybeSummarizeConversation(conversationId) {
    try {
        const messageCount = await Message.countDocuments({ conversationId });

        if (messageCount < config.conversation.summaryThreshold) {
            return null; // Not enough messages to warrant summarization
        }

        // Check if we already have a recent enough summary
        const existingSummary = await ConversationSummary.findOne({
            conversationId,
        })
            .sort({ createdAt: -1 })
            .lean();

        // Don't re-summarize if the existing summary covers most messages
        const recentMessages = 10; // Keep last N messages outside summary
        if (
            existingSummary &&
            existingSummary.messageRange.end >= messageCount - recentMessages - 5
        ) {
            return null; // Summary is recent enough
        }

        // Fetch messages to summarize (all except the last N)
        const messages = await Message.find({ conversationId })
            .sort({ createdAt: 1 })
            .lean();

        const messagesToSummarize = messages.slice(
            0,
            messages.length - recentMessages
        );

        if (messagesToSummarize.length < 4) {
            return null; // Too few messages to summarize
        }

        // Build conversation text for summarization
        const conversationText = messagesToSummarize
            .map((m) => {
                const role = m.role === "user" ? "User" : "Assistant";
                const content =
                    m.content.length > 500
                        ? m.content.slice(0, 500) + "…"
                        : m.content;
                return `${role}: ${content}`;
            })
            .join("\n\n");

        // Generate summary via Ollama
        const prompt = `Summarize the following conversation between a user and an AI assistant. Focus on:
1. Key topics discussed
2. Important questions asked and answers given
3. Any conclusions or decisions reached
4. Document references mentioned

Be concise but comprehensive. Write in 3rd person.

Conversation:
${conversationText}

Summary:`;

        const response = await axios.post(
            `${config.ollama.baseUrl}/api/generate`,
            {
                model: config.ollama.chatModel,
                prompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 300,
                    num_ctx: 4096,
                },
            }
        );

        let summary = (response.data.response || "").trim();

        if (!summary || summary.length < 20) {
            return null;
        }

        // Store the summary
        await ConversationSummary.create({
            conversationId,
            summary,
            messageRange: {
                start: 1,
                end: messagesToSummarize.length,
            },
            messageCount: messagesToSummarize.length,
        });

        console.log(
            `[ConversationSummarizer] Generated summary for ${conversationId}: ` +
                `${messagesToSummarize.length} messages → ${summary.length} chars`
        );

        return summary;
    } catch (error) {
        console.error(
            "[ConversationSummarizer] Failed to summarize:",
            error.message
        );
        return null;
    }
}

/**
 * Get the latest conversation summary for building prompts.
 * Returns the summary text and the number of messages it covers.
 *
 * @param {string} conversationId - The conversation to get summary for.
 * @returns {Promise<{summary: string, messagesCovered: number}|null>}
 */
async function getConversationSummary(conversationId) {
    try {
        const summary = await ConversationSummary.findOne({ conversationId })
            .sort({ createdAt: -1 })
            .lean();

        if (!summary) {
            return null;
        }

        return {
            summary: summary.summary,
            messagesCovered: summary.messageCount,
        };
    } catch (error) {
        console.error(
            "[ConversationSummarizer] Failed to get summary:",
            error.message
        );
        return null;
    }
}

module.exports = {
    maybeSummarizeConversation,
    getConversationSummary,
};
