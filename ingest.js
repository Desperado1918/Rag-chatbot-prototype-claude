// ============================================================================
// ingest.js — 100% Local RAG Ingestion Pipeline
// ============================================================================
// PDF Parsing:   pdfjs-dist with geometric column reconstruction (no cloud APIs)
// Chunking:      Native JS hierarchical parent/child with safe boundary splitting
// Embeddings:    Ollama nomic-embed-text (local)
// Vector Store:  ChromaDB with cosine distance (local)
// ============================================================================

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ChromaClient } = require("chromadb");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_URL = "http://127.0.0.1:11434";
const CHROMA_URL = "http://localhost:8000";
const EMBEDDING_MODEL = "nomic-embed-text";
const DOCUMENT_PATH = "./documents/notes.pdf";

// Chunking parameters — tuned for academic paper density
const STANDARD_CHUNK_SIZE = 1000;
const PARENT_CHUNK_SIZE = 1800;   // ~1500-2000 chars for deep academic context
const CHILD_CHUNK_SIZE = 450;     // ~400-500 chars for precise vector search

// Separator priority for boundary-safe splitting (most preferred first)
const SEPARATORS = ["\n\n", "\n", ". ", " "];

// ---------------------------------------------------------------------------
// Utility: Normalize chunking method input
// ---------------------------------------------------------------------------

function normalizeChunkingMethod(method = "hierarchical") {
    return method === "standard" ? "standard" : "hierarchical";
}

function getCollectionName(method = "hierarchical") {
    return `notes_${normalizeChunkingMethod(method)}`;
}

// ============================================================================
// REQUIREMENT 2: Layout-Aware PDF Parsing with pdfjs-dist
// ============================================================================
// Academic papers use two-column layouts. Standard text extraction concatenates
// left and right columns line-by-line, destroying reading order. This function
// extracts every text item with its X/Y coordinates, then reconstructs reading
// order geometrically: group by Y-row, detect column boundary, read left column
// top-to-bottom, then right column top-to-bottom.
// ============================================================================

/**
 * Load and extract text from a PDF using pdfjs-dist with layout awareness.
 * Groups text items by their Y-coordinate to form rows, detects a column
 * boundary from the X-coordinate distribution, and reads left-then-right
 * to reconstruct the correct reading order for two-column academic papers.
 *
 * @param {string} filePath - Path to the PDF file.
 * @returns {Promise<string>} - Clean, sequentially-ordered text.
 */
async function loadPdfText(filePath) {
    // pdfjs-dist must be loaded as an ES module even in CommonJS environments.
    // We use dynamic import() to handle this.
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Document not found at: ${absolutePath}`);
    }

    // Load the PDF document from the file system
    const data = new Uint8Array(fs.readFileSync(absolutePath));
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDocument = await loadingTask.promise;

    const totalPages = pdfDocument.numPages;
    const allPageTexts = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdfDocument.getPage(pageNum);
        const textContent = await page.getTextContent();

        // ---------------------------------------------------------------
        // Step 1: Extract text items with their geometric positions.
        // Each item has: { str, transform[4]=x, transform[5]=y, width, height }
        // ---------------------------------------------------------------
        const items = textContent.items
            .filter((item) => item.str && item.str.trim())
            .map((item) => ({
                text: item.str,
                x: Math.round(item.transform[4]),   // horizontal position
                y: Math.round(item.transform[5]),    // vertical position (PDF y-axis: bottom=0)
                width: item.width || 0,
                height: item.height || 0
            }));

        if (items.length === 0) {
            continue;
        }

        // ---------------------------------------------------------------
        // Step 2: Group text items into rows by Y-coordinate.
        // Items within Y_TOLERANCE pixels of each other are on the same line.
        // ---------------------------------------------------------------
        const Y_TOLERANCE = 3;
        const rows = [];
        const sortedByY = [...items].sort((a, b) => b.y - a.y); // top-to-bottom (PDF y is bottom-up)

        let currentRow = [sortedByY[0]];
        let currentY = sortedByY[0].y;

        for (let i = 1; i < sortedByY.length; i++) {
            const item = sortedByY[i];
            if (Math.abs(item.y - currentY) <= Y_TOLERANCE) {
                // Same row — group together
                currentRow.push(item);
            } else {
                // New row — flush the current one, start fresh
                rows.push(currentRow);
                currentRow = [item];
                currentY = item.y;
            }
        }
        rows.push(currentRow); // flush the last row

        // ---------------------------------------------------------------
        // Step 3: Detect column boundary using the X-coordinate midpoint.
        // For two-column papers, text clusters around two X regions.
        // We use the page viewport width / 2 as the column divider.
        // ---------------------------------------------------------------
        const viewport = page.getViewport({ scale: 1.0 });
        const pageMiddleX = viewport.width / 2;

        // ---------------------------------------------------------------
        // Step 4: Classify each row's items into left or right column.
        // If ALL items in a row span across the midpoint (e.g., title, abstract),
        // treat the entire row as a full-width row.
        // ---------------------------------------------------------------
        const leftColumnLines = [];
        const rightColumnLines = [];
        const fullWidthLines = [];

        for (const row of rows) {
            // Sort items in this row left-to-right
            const sortedRow = row.sort((a, b) => a.x - b.x);
            const rowText = sortedRow.map((item) => item.text).join(" ").trim();

            if (!rowText) {
                continue;
            }

            // Determine if this row spans across the column boundary
            const minX = sortedRow[0].x;
            const maxX = sortedRow[sortedRow.length - 1].x +
                         (sortedRow[sortedRow.length - 1].width || 0);

            // A row is "full-width" if it starts in the left column area
            // and ends in the right column area, spanning the midpoint.
            const COLUMN_MARGIN = 50; // tolerance for column detection
            const isFullWidth = minX < (pageMiddleX - COLUMN_MARGIN) &&
                                maxX > (pageMiddleX + COLUMN_MARGIN);

            if (isFullWidth) {
                // Full-width text (titles, headers, abstracts, tables)
                fullWidthLines.push({
                    text: rowText,
                    y: sortedRow[0].y
                });
            } else {
                // Split items into left and right columns
                const leftItems = sortedRow.filter((item) => item.x < pageMiddleX);
                const rightItems = sortedRow.filter((item) => item.x >= pageMiddleX);

                if (leftItems.length > 0) {
                    leftColumnLines.push({
                        text: leftItems.map((item) => item.text).join(" ").trim(),
                        y: leftItems[0].y
                    });
                }

                if (rightItems.length > 0) {
                    rightColumnLines.push({
                        text: rightItems.map((item) => item.text).join(" ").trim(),
                        y: rightItems[0].y
                    });
                }
            }
        }

        // ---------------------------------------------------------------
        // Step 5: Reconstruct reading order.
        // Full-width text first (sorted top-to-bottom by Y),
        // then left column top-to-bottom, then right column top-to-bottom.
        // This preserves the natural reading flow of academic papers.
        // ---------------------------------------------------------------

        // Sort each group by Y descending (top of page = highest Y in PDF coords)
        const sortByYDesc = (a, b) => b.y - a.y;
        fullWidthLines.sort(sortByYDesc);
        leftColumnLines.sort(sortByYDesc);
        rightColumnLines.sort(sortByYDesc);

        // Interleave: full-width lines go first if they appear above the columns,
        // then left column, then right column. For simplicity and correctness in
        // most academic layouts, we concatenate in this order.
        const pageLines = [];

        // Add full-width lines that appear above the column content
        const columnTopY = Math.max(
            leftColumnLines.length > 0 ? leftColumnLines[0].y : -Infinity,
            rightColumnLines.length > 0 ? rightColumnLines[0].y : -Infinity
        );

        // Full-width lines above the columns (titles, headers)
        const topFullWidth = fullWidthLines.filter((line) => line.y >= columnTopY);
        // Full-width lines below/within the columns (footnotes, tables)
        const bottomFullWidth = fullWidthLines.filter((line) => line.y < columnTopY);

        for (const line of topFullWidth) {
            pageLines.push(line.text);
        }

        // Left column, top to bottom
        for (const line of leftColumnLines) {
            pageLines.push(line.text);
        }

        // Right column, top to bottom
        for (const line of rightColumnLines) {
            pageLines.push(line.text);
        }

        // Bottom full-width content
        for (const line of bottomFullWidth) {
            pageLines.push(line.text);
        }

        const pageText = pageLines.join("\n");
        if (pageText.trim()) {
            allPageTexts.push(pageText.trim());
        }
    }

    // Join all pages with double newlines to mark page boundaries
    const fullText = allPageTexts.join("\n\n");

    // Clean up common PDF extraction artifacts
    return fullText
        .replace(/\r\n/g, "\n")         // normalize line endings
        .replace(/[ \t]+\n/g, "\n")     // trim trailing whitespace on lines
        .replace(/\n{3,}/g, "\n\n")     // collapse excessive blank lines
        .trim();
}

// ============================================================================
// REQUIREMENT 3: Safe Boundary-Aware Text Splitting (Native JS Only)
// ============================================================================
// No LangChain or external chunking libraries. This function splits text at
// the safest possible boundary (paragraph > sentence > word) while staying
// under the target size. This preserves academic terminology and avoids
// mid-word or mid-sentence breaks.
// ============================================================================

/**
 * Split text into chunks of approximately `maxSize` characters, breaking only
 * at safe linguistic boundaries. Tries paragraph breaks first (\n\n), then
 * line breaks (\n), then sentence endings (. ), then word boundaries ( ).
 *
 * @param {string} text - The text to split.
 * @param {number} maxSize - Maximum characters per chunk.
 * @returns {string[]} - Array of text chunks.
 */
function safeSplitText(text, maxSize) {
    const cleanText = text.trim();

    // Base case: text already fits in one chunk
    if (!cleanText || cleanText.length <= maxSize) {
        return cleanText ? [cleanText] : [];
    }

    // Try each separator in order of preference (most meaningful boundary first)
    for (const separator of SEPARATORS) {
        const parts = cleanText.split(separator).filter(Boolean);

        // If splitting didn't help (only 1 part), try the next separator
        if (parts.length <= 1) {
            continue;
        }

        const chunks = [];
        let current = "";

        for (const part of parts) {
            const trimmedPart = part.trim();
            if (!trimmedPart) {
                continue;
            }

            // Calculate what the chunk would look like if we add this part
            const candidate = current
                ? `${current}${separator}${trimmedPart}`
                : trimmedPart;

            if (candidate.length <= maxSize) {
                // Part fits — accumulate into the current chunk
                current = candidate;
            } else {
                // Part doesn't fit — flush current chunk and start fresh
                if (current) {
                    chunks.push(current.trim());
                }

                if (trimmedPart.length > maxSize) {
                    // This single part is still too large — recurse with the
                    // next finer-grained separator
                    const subChunks = safeSplitText(trimmedPart, maxSize);
                    chunks.push(...subChunks);
                    current = "";
                } else {
                    current = trimmedPart;
                }
            }
        }

        // Don't forget the last accumulated chunk
        if (current.trim()) {
            chunks.push(current.trim());
        }

        // Only return if we actually produced multiple chunks
        if (chunks.length > 0) {
            return chunks;
        }
    }

    // Absolute fallback: hard-split by character count (should be rare)
    const chunks = [];
    for (let i = 0; i < cleanText.length; i += maxSize) {
        const slice = cleanText.slice(i, i + maxSize).trim();
        if (slice) {
            chunks.push(slice);
        }
    }
    return chunks;
}

// ============================================================================
// Chunking: Standard (flat) and Hierarchical (parent/child)
// ============================================================================

/**
 * Create flat standard chunks — each chunk is an independent record.
 * Used as the baseline comparison in benchmarks.
 *
 * @param {string} text - Full document text.
 * @param {string} sourceFilename - Source filename for metadata.
 * @returns {Object[]} - Array of { id, document, metadata } records.
 */
function createStandardRecords(text, sourceFilename) {
    const chunks = safeSplitText(text, STANDARD_CHUNK_SIZE);

    return chunks.map((chunk, index) => ({
        id: `${sourceFilename}-standard-chunk-${index + 1}`,
        document: chunk,
        metadata: {
            chunkingMethod: "standard",
            source: sourceFilename,
            chunkNumber: index + 1
        }
    }));
}

/**
 * Create hierarchical parent/child chunks.
 *
 * The document is first split into large Parent Chunks (~1800 chars) to capture
 * broad academic context. Each parent is then subdivided into smaller Child
 * Chunks (~450 chars) for precise vector similarity search.
 *
 * Only the Child Chunks are embedded into ChromaDB. Each child's metadata
 * includes the parentId and the COMPLETE parentText, enabling context expansion
 * at query time: when a child matches, we retrieve the full parent for the LLM.
 *
 * @param {string} text - Full document text.
 * @param {string} sourceFilename - Source filename for metadata.
 * @returns {Object[]} - Array of { id, document, metadata } records.
 */
function createHierarchicalChunks(text, sourceFilename) {
    // Step 1: Split the full document into large parent chunks
    const parentChunks = safeSplitText(text, PARENT_CHUNK_SIZE);
    const records = [];

    parentChunks.forEach((parentText, parentIndex) => {
        const parentNumber = parentIndex + 1;
        const parentId = `${sourceFilename}-parent-${parentNumber}`;

        // Step 2: Subdivide each parent into smaller child chunks
        const childChunks = safeSplitText(parentText, CHILD_CHUNK_SIZE);

        childChunks.forEach((childText, childIndex) => {
            records.push({
                id: `${parentId}-child-${childIndex + 1}`,
                // The child text is what gets embedded as a vector
                document: childText,
                metadata: {
                    chunkingMethod: "hierarchical",
                    source: sourceFilename,
                    parentId,
                    parentNumber,
                    childNumber: childIndex + 1,
                    // CRITICAL: Store the complete parent text in metadata.
                    // ChromaDB searches the child vector, but at query time
                    // we expand to the parent text for richer LLM context.
                    parentText
                }
            });
        });
    });

    return records;
}

// ============================================================================
// Embedding: Ollama local embeddings
// ============================================================================

/**
 * Generate an embedding vector for the given text using Ollama's local
 * nomic-embed-text model. This never leaves the machine.
 *
 * @param {string} text - Text to embed.
 * @returns {Promise<number[]>} - Embedding vector.
 */
async function createEmbedding(text) {
    const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
        model: EMBEDDING_MODEL,
        prompt: text
    });

    return response.data.embedding;
}

// ============================================================================
// REQUIREMENT 4: ChromaDB Collection with Cosine Distance
// ============================================================================
// ChromaDB defaults to L2 (Euclidean) distance, which produces distances in
// the range [0, ∞) that are hard to threshold meaningfully. Cosine distance
// produces values in [0, 2] where 0 = identical, 2 = opposite. This maps
// cleanly to similarity via: similarity = 1 - distance (range [-1, 1]).
// ============================================================================

/**
 * Get or create a ChromaDB collection configured for cosine distance.
 * The { "hnsw:space": "cosine" } metadata tells ChromaDB's HNSW index to
 * use cosine distance instead of the default L2.
 *
 * @param {string} method - Chunking method ("standard" or "hierarchical").
 * @returns {Promise<Object>} - ChromaDB collection handle.
 */
async function getOrCreateCollection(method) {
    const client = new ChromaClient({ path: CHROMA_URL });

    return client.getOrCreateCollection({
        name: getCollectionName(method),
        metadata: { "hnsw:space": "cosine" }
    });
}

// ============================================================================
// Ingestion Pipeline: Parse → Chunk → Embed → Store
// ============================================================================

/**
 * Build chunking records from a PDF file. Parses the PDF with layout awareness,
 * then chunks the text using the specified method.
 *
 * @param {string} filePath - Path to the PDF file.
 * @param {string} method - "standard" or "hierarchical".
 * @returns {Promise<Object>} - { sourceFilename, textLength, records }
 */
async function buildRecords(filePath, method) {
    const sourceFilename = path.basename(filePath);
    const text = await loadPdfText(filePath);

    // Save parsed text for debugging and inspection
    fs.writeFileSync("parsed.txt", text);
    console.log("Parsed text saved to parsed.txt");

    // Log a quick sanity check
    console.log(
        "Contains 'Retrieval-Augmented Generation':",
        text.includes("Retrieval-Augmented Generation")
    );

    const records =
        method === "standard"
            ? createStandardRecords(text, sourceFilename)
            : createHierarchicalChunks(text, sourceFilename);

    return {
        sourceFilename,
        textLength: text.length,
        records
    };
}

/**
 * Full ingestion pipeline: parse a PDF, chunk it, embed each chunk, and
 * store all vectors in ChromaDB. Progress is logged to the console.
 *
 * @param {string} filePath - Path to the PDF (defaults to DOCUMENT_PATH).
 * @param {Object} options - { chunkingMethod: "standard" | "hierarchical" }
 * @returns {Promise<Object>} - Ingestion summary.
 */
async function ingestDocument(filePath = DOCUMENT_PATH, options = {}) {
    const method = normalizeChunkingMethod(options.chunkingMethod);
    const collection = await getOrCreateCollection(method);
    const { sourceFilename, textLength, records } = await buildRecords(filePath, method);

    console.log("PDF loaded:", sourceFilename);
    console.log("Chunking method:", method);
    console.log("Characters:", textLength);
    console.log("Vector records:", records.length);
    console.log("Collection:", getCollectionName(method));

    // Embed and store each record sequentially.
    // Sequential embedding avoids overwhelming Ollama with concurrent requests.
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const embedding = await createEmbedding(record.document);

        await collection.upsert({
            ids: [record.id],
            embeddings: [embedding],
            documents: [record.document],
            metadatas: [record.metadata]
        });

        console.log(`Stored vector ${i + 1}/${records.length}`);
    }

    return {
        source: sourceFilename,
        chunkingMethod: method,
        collection: getCollectionName(method),
        recordsStored: records.length
    };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
    const chunkingMethod = process.argv[2] || "hierarchical";
    await ingestDocument(DOCUMENT_PATH, { chunkingMethod });
}

if (require.main === module) {
    main().catch(console.error);
}

// ============================================================================
// Exports — API surface for server.js and benchmark.js
// ============================================================================

module.exports = {
    createHierarchicalChunks,
    createStandardRecords,
    getCollectionName,
    getOrCreateCollection,
    ingestDocument,
    loadPdfText,
    normalizeChunkingMethod,
    safeSplitText,
    createEmbedding,
    // Export constants for benchmark access
    PARENT_CHUNK_SIZE,
    CHILD_CHUNK_SIZE,
    STANDARD_CHUNK_SIZE,
    DOCUMENT_PATH
};
