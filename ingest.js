const fs = require("fs");
const { PDFParse } = require("pdf-parse");
const axios = require("axios");
const { ChromaClient } = require("chromadb");

async function main() {
    // Read PDF
    const dataBuffer = fs.readFileSync("./documents/notes.pdf");

    const parser = new PDFParse({ data: dataBuffer });

    const pdfData = await parser.getText();

    const text = pdfData.text;

    console.log("PDF Loaded");
    console.log("Characters:", text.length);

    // Chunking with overlap keeps nearby context available during retrieval.
    const chunkSize = 1000;
    const chunkOverlap = 200;
    const chunkStep = chunkSize - chunkOverlap;
    const chunks = [];

    for (let i = 0; i < text.length; i += chunkStep) {
        chunks.push(text.slice(i, i + chunkSize));
    }

    console.log("Chunks:", chunks.length);

    // Connect Chroma
    const client = new ChromaClient({
        path: "http://localhost:8000"
    });

    const collection = await client.getOrCreateCollection({
        name: "notes"
    });

    console.log("Connected to Chroma");

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const embeddingResponse = await axios.post(
            "http://127.0.0.1:11434/api/embeddings",
            {
                model: "nomic-embed-text",
                prompt: chunk
            }
        );

        const embedding = embeddingResponse.data.embedding;

        await collection.add({
            ids: [`chunk-${i}`],
            embeddings: [embedding],
            documents: [chunk]
        });

        console.log(`Stored chunk ${i + 1}/${chunks.length}`);
    }

    console.log("DONE");
}

main().catch(console.error);
