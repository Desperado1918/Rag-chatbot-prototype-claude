// ============================================================================
// services/chunkingService.js — Recursive Character Text Splitter
// ============================================================================
// Hand-written (~40 lines of core logic) recursive character splitter.
// No LangChain dependency. Implements "Level 2" splitting from Greg Kamradt's
// 5 Levels of Text Splitting.
//
// Strategy: try to split on paragraph breaks first, then newlines, then
// sentence endings, then spaces — in that order of preference. This keeps
// semantic units intact as much as possible.
// ============================================================================

const config = require("../config");

// Rough token estimate: ~4 characters per token (English average)
const CHARS_PER_TOKEN = 4;

/**
 * Split text using a recursive character splitting strategy.
 *
 * @param {string} text - Text to split.
 * @param {Object} [options] - Override defaults.
 * @param {number} [options.maxTokens] - Max tokens per chunk (~500).
 * @param {number} [options.overlapTokens] - Overlap tokens between chunks (~50).
 * @param {string[]} [options.separators] - Separator hierarchy.
 * @returns {string[]} - Array of text chunks.
 */
function splitText(text, options = {}) {
    const maxTokens = options.maxTokens || config.chunking.maxTokens;
    const overlapTokens = options.overlapTokens || config.chunking.overlapTokens;
    const separators = options.separators || config.chunking.separators;

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    const overlapChars = overlapTokens * CHARS_PER_TOKEN;

    return recursiveSplit(text.trim(), separators, maxChars, overlapChars);
}

/**
 * Core recursive splitting logic.
 */
function recursiveSplit(text, separators, maxChars, overlapChars) {
    // Base case: text fits in one chunk
    if (text.length <= maxChars) {
        return text.trim() ? [text.trim()] : [];
    }

    // Find the best separator (first one that appears in the text)
    let bestSep = "";
    let remainingSeparators = [];

    for (let i = 0; i < separators.length; i++) {
        if (text.includes(separators[i])) {
            bestSep = separators[i];
            remainingSeparators = separators.slice(i + 1);
            break;
        }
    }

    // If no separator found, hard-split at maxChars as a last resort
    if (!bestSep) {
        return hardSplit(text, maxChars, overlapChars);
    }

    // Split on the best separator
    const parts = text.split(bestSep);
    const chunks = [];
    let currentChunk = "";

    for (const part of parts) {
        const candidate = currentChunk
            ? currentChunk + bestSep + part
            : part;

        if (candidate.length <= maxChars) {
            currentChunk = candidate;
        } else {
            // Flush current chunk
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }

            // If this single part is still too long, recurse with finer separators
            if (part.length > maxChars && remainingSeparators.length > 0) {
                const subChunks = recursiveSplit(
                    part,
                    remainingSeparators,
                    maxChars,
                    overlapChars
                );
                chunks.push(...subChunks);
                currentChunk = "";
            } else if (part.length > maxChars) {
                // No more separators — hard split
                chunks.push(...hardSplit(part, maxChars, overlapChars));
                currentChunk = "";
            } else {
                currentChunk = part;
            }
        }
    }

    // Flush remaining
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    // Apply overlap between adjacent chunks
    return applyOverlap(chunks, overlapChars);
}

/**
 * Hard-split text at character boundaries when no separator works.
 */
function hardSplit(text, maxChars, overlapChars) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + maxChars, text.length);
        const chunk = text.slice(start, end).trim();
        if (chunk) {
            chunks.push(chunk);
        }
        start = end - overlapChars;
        if (start >= text.length) break;
        // Prevent infinite loop
        if (end === text.length) break;
    }

    return chunks;
}

/**
 * Add overlap between adjacent chunks by prepending the tail of the
 * previous chunk to the start of the next chunk.
 */
function applyOverlap(chunks, overlapChars) {
    if (chunks.length <= 1 || overlapChars <= 0) {
        return chunks;
    }

    const result = [chunks[0]];

    for (let i = 1; i < chunks.length; i++) {
        const prevChunk = chunks[i - 1];
        const overlapText = prevChunk.slice(-overlapChars);
        result.push(overlapText + " " + chunks[i]);
    }

    return result;
}

/**
 * Format a conversation turn (user + assistant) as a single text block,
 * then chunk it if it exceeds the token limit.
 *
 * @param {string} userMsg - The user's message content.
 * @param {string} assistantMsg - The assistant's reply content.
 * @param {Object} [options] - Chunking options.
 * @returns {string[]} - Array of text chunks.
 */
function chunkConversationTurn(userMsg, assistantMsg, options = {}) {
    const turnText = `User: ${userMsg}\n\nAssistant: ${assistantMsg}`;
    const maxChars = (options.maxTokens || config.chunking.maxTokens) * CHARS_PER_TOKEN;

    // If the turn fits in one chunk, return as-is
    if (turnText.length <= maxChars) {
        return [turnText];
    }

    // Otherwise, split it
    return splitText(turnText, options);
}

module.exports = { splitText, chunkConversationTurn, CHARS_PER_TOKEN };
