const axios = require("axios");
const { ChromaClient } = require("chromadb");

const OLLAMA_URL = "http://127.0.0.1:11434";
const CHROMA_URL = "http://localhost:8000";
const COLLECTION_NAME = "notes";
const EMBEDDING_MODEL = "nomic-embed-text";
const CHAT_MODEL = "llama3.2:3b";

function createServiceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

async function askQuestion(question) {
    if (!question || !question.trim()) {
        throw createServiceError("Question is required", 400);
    }

    let embeddingResponse;

    try {
        embeddingResponse = await axios.post(
            `${OLLAMA_URL}/api/embeddings`,
            {
                model: EMBEDDING_MODEL,
                prompt: question
            }
        );
    } catch (error) {
        throw createServiceError(
            `Ollama embedding model is not responding. Make sure Ollama is running and the ${EMBEDDING_MODEL} model is installed.`
        );
    }

    const queryEmbedding = embeddingResponse.data.embedding;

    const client = new ChromaClient({
        path: CHROMA_URL
    });

    let collection;

    try {
        collection = await client.getCollection({
            name: COLLECTION_NAME
        });
    } catch (error) {
        throw createServiceError(
            `Chroma collection "${COLLECTION_NAME}" was not found. Start Chroma on port 8000 and run "npm run ingest" first.`
        );
    }

    let results;

    try {
        results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: 3
        });
    } catch (error) {
        throw createServiceError(
            "Chroma query failed. Make sure the Chroma server is running on http://localhost:8000."
        );
    }

    const documents = results.documents?.[0] || [];

    if (documents.length === 0) {
        return {
            answer: "I don't know based on the provided documents.",
            sources: []
        };
    }

    const context = documents.join("\n\n");

    const prompt = `
    Answer ONLY using the context below.

    Context:
    ${context}

    Question:
    ${question}

    If the answer is not in the context, say:
    "I don't know based on the provided documents."
    `;

    let response;

    try {
        response = await axios.post(
            `${OLLAMA_URL}/api/generate`,
            {
                model: CHAT_MODEL,
                prompt: prompt,
                stream: false
            }
        );
    } catch (error) {
        throw createServiceError(
            `Ollama chat model is not responding. Make sure the ${CHAT_MODEL} model is installed.`
        );
    }

    return {
        answer: response.data.response,
        sources: documents
    };
}

async function main() {
    const question = process.argv.slice(2).join(" ") || "What is RAG?";
    const result = await askQuestion(question);

    console.log("\nRETRIEVED CHUNKS:\n");
    console.log(result.sources);

    console.log("\nANSWER:\n");
    console.log(result.answer);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    askQuestion
};
