const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");
const axios = require("axios");
const { ChromaClient } = require("chromadb");

const OLLAMA_URL = "http://127.0.0.1:11434";
const CHROMA_URL = "http://localhost:8000";
const COLLECTION_NAME = "notes";
const EMBEDDING_MODEL = "nomic-embed-text";
const DOCUMENT_PATH = "./documents/notes.pdf";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

async function loadPdfText(filePath) {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    const pdfData = await parser.getText();

    return pdfData.text.replace(/\r\n/g, "\n").trim();
}

function splitByCharacterCount(text, chunkSize) {
    const chunks = [];

    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize).trim());
    }

    return chunks.filter(Boolean);
}

function recursiveSplit(text, separators = SEPARATORS) {
    const cleanText = text.trim();

    if (!cleanText) {
        return [];
    }

    if (cleanText.length <= CHUNK_SIZE) {
        return [cleanText];
    }

    const [separator, ...nextSeparators] = separators;

    if (separator === "") {
        return splitByCharacterCount(cleanText, CHUNK_SIZE);
    }

    const parts = cleanText
        .split(separator)
        .map((part) => part.trim())
        .filter(Boolean);

    const chunks = [];
    let current = "";

    for (const part of parts) {
        const next = current ? `${current}${separator}${part}` : part;

        if (next.length <= CHUNK_SIZE) {
            current = next;
            continue;
        }

        if (current) {
            chunks.push(current);
            current = "";
        }

        if (part.length > CHUNK_SIZE) {
            chunks.push(...recursiveSplit(part, nextSeparators));
        } else {
            current = part;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}

function addChunkOverlap(chunks) {
    const overlappedChunks = [];
    let previousChunk = "";

    for (const chunk of chunks) {
        if (!previousChunk) {
            overlappedChunks.push(chunk);
            previousChunk = chunk;
            continue;
        }

        const overlap = previousChunk.slice(-CHUNK_OVERLAP);
        const chunkWithOverlap = `${overlap}\n${chunk}`.slice(0, CHUNK_SIZE);
        overlappedChunks.push(chunkWithOverlap);
        previousChunk = chunkWithOverlap;
    }

    return overlappedChunks;
}

function createChunks(text) {
    const recursiveChunks = recursiveSplit(text);

    return addChunkOverlap(recursiveChunks);
}

async function createEmbedding(text) {
    const embeddingResponse = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
        model: EMBEDDING_MODEL,
        prompt: text
    });

    return embeddingResponse.data.embedding;
}

async function resetCollection() {
    const client = new ChromaClient({
        path: CHROMA_URL
    });

    try {
        await client.deleteCollection({
            name: COLLECTION_NAME
        });
        console.log(`Reset existing Chroma collection: ${COLLECTION_NAME}`);
    } catch (error) {
        console.log(`Creating new Chroma collection: ${COLLECTION_NAME}`);
    }

    return client.getOrCreateCollection({
        name: COLLECTION_NAME
    });
}

async function ingestDocument(filePath) {
    const sourceFilename = path.basename(filePath);
    const text = await loadPdfText(filePath);
    const chunks = createChunks(text);
    const collection = await resetCollection();

    console.log("PDF loaded:", sourceFilename);
    console.log("Characters:", text.length);
    console.log("Chunks:", chunks.length);
    console.log("Connected to Chroma");

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await createEmbedding(chunk);

        await collection.upsert({
            ids: [`${sourceFilename}-chunk-${i + 1}`],
            embeddings: [embedding],
            documents: [chunk],
            metadatas: [
                {
                    source: sourceFilename,
                    chunkNumber: i + 1
                }
            ]
        });

        console.log(`Stored chunk ${i + 1}/${chunks.length}`);
    }

    console.log("DONE");
}

async function main() {
    await ingestDocument(DOCUMENT_PATH);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    createChunks,
    ingestDocument,
    recursiveSplit,
    resetCollection
};
