const axios = require("axios");
const { ChromaClient } = require("chromadb");

const OLLAMA_URL = "http://127.0.0.1:11434";
const CHROMA_URL = "http://localhost:8000";
const COLLECTION_NAME = "notes";
const EMBEDDING_MODEL = "nomic-embed-text";
const CHAT_MODEL = "llama3.2:3b";
const RETRIEVAL_COUNT = 10;

function createServiceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeChunk(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function distanceToSimilarity(distance) {
    if (typeof distance !== "number") {
        return null;
    }

    return Number((1 / (1 + distance)).toFixed(4));
}

async function createEmbedding(text) {
    try {
        const embeddingResponse = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
            model: EMBEDDING_MODEL,
            prompt: text
        });

        return embeddingResponse.data.embedding;
    } catch (error) {
        throw createServiceError(
            `Ollama embedding model is not responding. Make sure Ollama is running and the ${EMBEDDING_MODEL} model is installed.`
        );
    }
}

async function getCollection() {
    const client = new ChromaClient({
        path: CHROMA_URL
    });

    try {
        return await client.getCollection({
            name: COLLECTION_NAME
        });
    } catch (error) {
        throw createServiceError(
            `Chroma collection "${COLLECTION_NAME}" was not found. Start Chroma on port 8000 and run "npm run ingest" first.`
        );
    }
}

async function retrieveChunks(question) {
    const queryEmbedding = await createEmbedding(question);
    const collection = await getCollection();

    try {
        const results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: RETRIEVAL_COUNT,
            include: ["documents", "metadatas", "distances"]
        });

        return formatRetrievedChunks(results);
    } catch (error) {
        throw createServiceError(
            "Chroma query failed. Make sure the Chroma server is running on http://localhost:8000."
        );
    }
}

function formatRetrievedChunks(results) {
    const documents = results.documents?.[0] || [];
    const metadatas = results.metadatas?.[0] || [];
    const distances = results.distances?.[0] || [];

    return documents.map((document, index) => ({
        text: document,
        metadata: metadatas[index] || {},
        distance: distances[index],
        similarity: distanceToSimilarity(distances[index])
    }));
}

function removeDuplicateChunks(chunks) {
    const seen = new Set();
    const uniqueChunks = [];

    for (const chunk of chunks) {
        const key = normalizeChunk(chunk.text);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        uniqueChunks.push(chunk);
    }

    return uniqueChunks;
}

function logRetrievedChunks(chunks) {
    console.log("\nRetrieved chunks:");

    chunks.forEach((chunk, index) => {
        const source = chunk.metadata.source || "unknown";
        const chunkNumber = chunk.metadata.chunkNumber || "unknown";
        const score = chunk.similarity ?? "unknown";
        const preview = chunk.text.replace(/\s+/g, " ").slice(0, 160);

        console.log(
            `${index + 1}. source=${source}, chunk=${chunkNumber}, similarity=${score}, preview="${preview}"`
        );
    });
}

function buildContext(chunks) {
    return chunks
        .map((chunk, index) => {
            const source = chunk.metadata.source || "unknown";
            const chunkNumber = chunk.metadata.chunkNumber || "unknown";

            return `[Source ${index + 1}: ${source}, chunk ${chunkNumber}]\n${chunk.text}`;
        })
        .join("\n\n---\n\n");
}

function buildPrompt(question, chunks) {
    const context = buildContext(chunks);

    return `
You are a RAG assistant. Answer the question using ONLY the context below.

Rules:
- Combine relevant details from multiple chunks when needed.
- Do not use outside knowledge.
- If the answer is not present in the context, say exactly: "I don't know based on the provided documents."
- Keep the answer clear and concise.

Context:
${context}

Question:
${question}
`;
}

function buildSources(chunks) {
    return chunks.map((chunk) => ({
        source: chunk.metadata.source || "unknown",
        chunkNumber: chunk.metadata.chunkNumber || null,
        similarity: chunk.similarity,
        text: chunk.text
    }));
}

async function generateAnswer(prompt) {
    try {
        const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
            model: CHAT_MODEL,
            prompt: prompt,
            stream: false
        });

        return response.data.response;
    } catch (error) {
        throw createServiceError(
            `Ollama chat model is not responding. Make sure the ${CHAT_MODEL} model is installed.`
        );
    }
}

async function askQuestion(question) {
    if (!question || !question.trim()) {
        throw createServiceError("Question is required", 400);
    }

    const retrievedChunks = await retrieveChunks(question);
    const uniqueChunks = removeDuplicateChunks(retrievedChunks);

    logRetrievedChunks(uniqueChunks);

    if (uniqueChunks.length === 0) {
        return {
            answer: "I don't know based on the provided documents.",
            sources: []
        };
    }

    const prompt = buildPrompt(question, uniqueChunks);
    const answer = await generateAnswer(prompt);

    return {
        answer,
        sources: buildSources(uniqueChunks)
    };
}

async function main() {
    const question = process.argv.slice(2).join(" ") || "What is RAG?";
    const result = await askQuestion(question);

    console.log("\nANSWER:\n");
    console.log(result.answer);
    console.log("\nSOURCES:\n");
    console.log(result.sources);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    askQuestion,
    buildPrompt,
    removeDuplicateChunks,
    retrieveChunks
};
