// ============================================================================
// query.js — Thin Facade (Backward-Compatible)
// ============================================================================
// This file now delegates to the modular services under backend/services/.
// It preserves the exact same public API so that server.js and benchmark.js
// continue to work without any import changes.
// ============================================================================

const config = require("./backend/config");
const {
    getCollectionName,
    normalizeChunkingMethod,
} = require("./backend/services/ingestion");
const {
    distanceToSimilarity,
    retrieveVectorHits: _retrieveVectorHits,
    applySimilarityGate,
    expandHierarchicalParents,
    hybridRerank,
    buildContextChunks,
    logRetrievedChunks,
    buildSources,
} = require("./backend/services/retrieval");
const {
    buildPrompt,
    streamOllamaAnswer,
} = require("./backend/services/generation");

// ---------------------------------------------------------------------------
// Re-export constants for backward compatibility (benchmark.js uses these)
// ---------------------------------------------------------------------------

const SAFE_UNKNOWN_ANSWER = config.safeUnknownAnswer;
const SIMILARITY_THRESHOLD = config.retrieval.similarityThreshold;

// ---------------------------------------------------------------------------
// Wrapped retrieveVectorHits — translates chunkingMethod to collectionName
// ---------------------------------------------------------------------------

async function retrieveVectorHits(question, chunkingMethod) {
    const collectionName = getCollectionName(chunkingMethod);
    return _retrieveVectorHits(question, collectionName);
}

// ---------------------------------------------------------------------------
// Answer Preparation: Retrieval → Gate → Re-Rank → Context → Prompt
// ---------------------------------------------------------------------------

async function prepareAnswer(question, options = {}) {
    if (!question || !question.trim()) {
        const { createServiceError } = require("./backend/utils/errors");
        throw createServiceError("Question is required", 400);
    }

    const { performHybridDualRetrieval } = require("./backend/services/hybridRetrieval");
    const chunkingMethod = normalizeChunkingMethod(options.chunkingMethod);

    const retrievalResult = await performHybridDualRetrieval(question, {
        chunkingMethod,
        conversationId: options.conversationId,
    });

    if (retrievalResult.contextChunks.length === 0) {
        return {
            shouldGenerate: false,
            answer: SAFE_UNKNOWN_ANSWER,
            sources: [],
            chunkingMethod,
        };
    }

    return {
        shouldGenerate: true,
        prompt: buildPrompt(question, retrievalResult.contextChunks, {
            conversationContext: retrievalResult.conversationContext,
        }),
        sources: retrievalResult.sources,
        chunkingMethod,
    };
}

// ---------------------------------------------------------------------------
// Public API: Streaming and non-streaming question answering
// ---------------------------------------------------------------------------

async function askQuestionStream(question, options = {}, handlers = {}) {
    const prepared = await prepareAnswer(question, options);

    handlers.onSources?.(prepared.sources, prepared.chunkingMethod);

    if (!prepared.shouldGenerate) {
        handlers.onToken?.(prepared.answer);
        handlers.onDone?.();
        return prepared;
    }

    await streamOllamaAnswer(prepared.prompt, handlers);

    return prepared;
}

async function askQuestion(question, options = {}) {
    let answer = "";
    const prepared = await askQuestionStream(question, options, {
        onToken: (token) => {
            answer += token;
        },
    });

    return {
        answer: answer || prepared.answer,
        sources: prepared.sources,
        chunkingMethod: prepared.chunkingMethod,
    };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
    const question = process.argv.slice(2).join(" ") || "What is RAG?";
    const result = await askQuestion(question, {
        chunkingMethod: "hierarchical",
    });

    console.log("\nANSWER:\n");
    console.log(result.answer);
    console.log("\nSOURCES:\n");
    console.log(result.sources);
}

if (require.main === module) {
    main().catch(console.error);
}

// ---------------------------------------------------------------------------
// Exports — Exact same public API as before
// ---------------------------------------------------------------------------

module.exports = {
    SAFE_UNKNOWN_ANSWER,
    SIMILARITY_THRESHOLD,
    askQuestion,
    askQuestionStream,
    buildPrompt,
    prepareAnswer,
    // Export for benchmark access
    retrieveVectorHits,
    applySimilarityGate,
    expandHierarchicalParents,
    distanceToSimilarity,
};
