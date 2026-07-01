// ============================================================================
// services/ingestion.js — Document Ingestion Pipeline
// ============================================================================
// Extracted from ingest.js. Handles:
//   1. Layout-aware PDF parsing (pdfjs-dist)
//   2. Text cleaning and noise removal
//   3. Boundary-safe text splitting
//   4. Standard and hierarchical chunking
//   5. ChromaDB collection management and storage
// ============================================================================

const fs = require("fs");
const path = require("path");
const { ChromaClient } = require("chromadb");
const config = require("../config");
const { createEmbedding } = require("./embedding");

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
// Layout-Aware PDF Parsing with pdfjs-dist
// ============================================================================

async function loadPdfText(filePath) {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Document not found at: ${absolutePath}`);
    }

    const data = new Uint8Array(fs.readFileSync(absolutePath));
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDocument = await loadingTask.promise;

    const totalPages = pdfDocument.numPages;
    const allPageTexts = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdfDocument.getPage(pageNum);
        const textContent = await page.getTextContent();

        const items = textContent.items
            .filter((item) => item.str && item.str.trim())
            .map((item) => ({
                text: item.str,
                x: Math.round(item.transform[4]),
                y: Math.round(item.transform[5]),
                width: item.width || 0,
                height: item.height || 0,
            }));

        if (items.length === 0) {
            continue;
        }

        const Y_TOLERANCE = 3;
        const rows = [];
        const sortedByY = [...items].sort((a, b) => b.y - a.y);

        let currentRow = [sortedByY[0]];
        let currentY = sortedByY[0].y;

        for (let i = 1; i < sortedByY.length; i++) {
            const item = sortedByY[i];
            if (Math.abs(item.y - currentY) <= Y_TOLERANCE) {
                currentRow.push(item);
            } else {
                rows.push(currentRow);
                currentRow = [item];
                currentY = item.y;
            }
        }
        rows.push(currentRow);

        const viewport = page.getViewport({ scale: 1.0 });
        const pageMiddleX = viewport.width / 2;

        const leftColumnLines = [];
        const rightColumnLines = [];
        const fullWidthLines = [];

        for (const row of rows) {
            const sortedRow = row.sort((a, b) => a.x - b.x);
            const rowText = sortedRow
                .map((item) => item.text)
                .join(" ")
                .trim();

            if (!rowText) {
                continue;
            }

            const minX = sortedRow[0].x;
            const maxX =
                sortedRow[sortedRow.length - 1].x +
                (sortedRow[sortedRow.length - 1].width || 0);

            const COLUMN_MARGIN = 50;
            const isFullWidth =
                minX < pageMiddleX - COLUMN_MARGIN &&
                maxX > pageMiddleX + COLUMN_MARGIN;

            if (isFullWidth) {
                fullWidthLines.push({ text: rowText, y: sortedRow[0].y });
            } else {
                const leftItems = sortedRow.filter(
                    (item) => item.x < pageMiddleX
                );
                const rightItems = sortedRow.filter(
                    (item) => item.x >= pageMiddleX
                );

                if (leftItems.length > 0) {
                    leftColumnLines.push({
                        text: leftItems
                            .map((item) => item.text)
                            .join(" ")
                            .trim(),
                        y: leftItems[0].y,
                    });
                }

                if (rightItems.length > 0) {
                    rightColumnLines.push({
                        text: rightItems
                            .map((item) => item.text)
                            .join(" ")
                            .trim(),
                        y: rightItems[0].y,
                    });
                }
            }
        }

        const sortByYDesc = (a, b) => b.y - a.y;
        fullWidthLines.sort(sortByYDesc);
        leftColumnLines.sort(sortByYDesc);
        rightColumnLines.sort(sortByYDesc);

        const pageLines = [];

        const columnTopY = Math.max(
            leftColumnLines.length > 0 ? leftColumnLines[0].y : -Infinity,
            rightColumnLines.length > 0 ? rightColumnLines[0].y : -Infinity
        );

        const topFullWidth = fullWidthLines.filter(
            (line) => line.y >= columnTopY
        );
        const bottomFullWidth = fullWidthLines.filter(
            (line) => line.y < columnTopY
        );

        for (const line of topFullWidth) {
            pageLines.push(line.text);
        }
        for (const line of leftColumnLines) {
            pageLines.push(line.text);
        }
        for (const line of rightColumnLines) {
            pageLines.push(line.text);
        }
        for (const line of bottomFullWidth) {
            pageLines.push(line.text);
        }

        const pageText = pageLines.join("\n");
        if (pageText.trim()) {
            allPageTexts.push(pageText.trim());
        }
    }

    const fullText = allPageTexts.join("\n\n");

    const rawCleaned = fullText
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return cleanExtractedText(rawCleaned);
}

// ============================================================================
// PDF Text Post-Processor
// ============================================================================

function cleanExtractedText(text) {
    const bibPattern =
        /^(?:\d{1,2}\.?\s*)?(?:references|bibliography|works\s+cited)\s*$/im;
    const bibMatch = text.match(bibPattern);
    if (bibMatch) {
        text = text.slice(0, bibMatch.index).trim();
        console.log(
            `[Bibliography Filter] Truncated text at "${bibMatch[0].trim()}" header (removed ${text.length} → end)`
        );
    }

    const lines = text.split("\n");
    const cleaned = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            cleaned.push("");
            continue;
        }

        if (
            /^[\d\s\.,;:!?\-–—\+\=\*\/\(\)\[\]\{\}†‡∑∏≈≤≥×÷→←↑↓∈∉⊆⊇∀∃∂∇αβγδεζηθλμνξπρσστυφχψω]+$/.test(
                line
            )
        ) {
            continue;
        }

        if (/^\[\d[\d,\s]*\]$/.test(line)) {
            continue;
        }

        if (/^(https?:\/\/|arxiv:|doi:|https:|http:|:\/{2})/.test(line)) {
            continue;
        }

        if (/^\d{1,2}(\.\d{1,2}){0,2}$/.test(line)) {
            continue;
        }

        if (line.length < 20 && !/^[A-Z]/.test(line)) {
            continue;
        }

        if (
            /^[a-zA-Zα-ωΑ-Ω\s\d\(\)\[\]\{\}:,\-∈θηφλ]+$/.test(line) &&
            line.length < 40 &&
            /[α-ωΑ-Ω]/.test(line)
        ) {
            continue;
        }

        if (/^[\d\.\s%\-–]+$/.test(line) && line.length < 60) {
            continue;
        }

        cleaned.push(line);
    }

    return cleaned
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ============================================================================
// Safe Boundary-Aware Text Splitting
// ============================================================================

function safeSplitText(text, maxSize, overlapSize = config.chunking.overlapSize) {
    const cleanText = text.trim();

    if (!cleanText || cleanText.length <= maxSize) {
        return cleanText ? [cleanText] : [];
    }

    function extractOverlapTail(chunk) {
        if (!overlapSize || overlapSize <= 0 || chunk.length <= overlapSize) {
            return "";
        }
        let tail = chunk.slice(-overlapSize);
        const firstSpace = tail.indexOf(" ");
        if (firstSpace > 0 && firstSpace < tail.length - 1) {
            tail = tail.slice(firstSpace + 1);
        }
        return tail.trim();
    }

    for (const separator of config.chunking.separators) {
        const parts = cleanText.split(separator).filter(Boolean);

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

            const candidate = current
                ? `${current}${separator}${trimmedPart}`
                : trimmedPart;

            if (candidate.length <= maxSize) {
                current = candidate;
            } else {
                if (current) {
                    const flushed = current.trim();
                    chunks.push(flushed);

                    const overlapTail = extractOverlapTail(flushed);
                    current = overlapTail ? overlapTail : "";
                }

                if (trimmedPart.length > maxSize) {
                    const subChunks = safeSplitText(
                        trimmedPart,
                        maxSize,
                        overlapSize
                    );
                    chunks.push(...subChunks);
                    const lastSub = subChunks[subChunks.length - 1] || "";
                    current = extractOverlapTail(lastSub);
                } else {
                    current = current
                        ? `${current} ${trimmedPart}`
                        : trimmedPart;
                }
            }
        }

        if (current.trim()) {
            chunks.push(current.trim());
        }

        if (chunks.length > 0) {
            return chunks;
        }
    }

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

function createStandardRecords(text, sourceFilename) {
    const chunks = safeSplitText(text, config.chunking.standardChunkSize);

    return chunks.map((chunk, index) => ({
        id: `${sourceFilename}-standard-chunk-${index + 1}`,
        document: chunk,
        metadata: {
            chunkingMethod: "standard",
            source: sourceFilename,
            chunkNumber: index + 1,
        },
    }));
}

function createHierarchicalChunks(text, sourceFilename) {
    const parentChunks = safeSplitText(text, config.chunking.parentChunkSize);
    const records = [];

    parentChunks.forEach((parentText, parentIndex) => {
        const parentNumber = parentIndex + 1;
        const parentId = `${sourceFilename}-parent-${parentNumber}`;

        const childChunks = safeSplitText(
            parentText,
            config.chunking.childChunkSize
        );

        childChunks.forEach((childText, childIndex) => {
            records.push({
                id: `${parentId}-child-${childIndex + 1}`,
                document: childText,
                metadata: {
                    chunkingMethod: "hierarchical",
                    source: sourceFilename,
                    parentId,
                    parentNumber,
                    childNumber: childIndex + 1,
                    parentText,
                },
            });
        });
    });

    return records;
}

// ============================================================================
// ChromaDB Collection Management
// ============================================================================

async function getOrCreateCollection(method) {
    const client = new ChromaClient({ path: config.chroma.url });

    return client.getOrCreateCollection({
        name: getCollectionName(method),
        metadata: { "hnsw:space": "cosine" },
    });
}

// ============================================================================
// Ingestion Pipeline
// ============================================================================

async function buildRecords(filePath, method) {
    const sourceFilename = path.basename(filePath);
    const text = await loadPdfText(filePath);

    fs.writeFileSync("parsed.txt", text);
    console.log("Parsed text saved to parsed.txt");

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
        records,
    };
}

async function ingestDocument(
    filePath = config.documents.defaultPath,
    options = {}
) {
    const method = normalizeChunkingMethod(options.chunkingMethod);
    const collection = await getOrCreateCollection(method);
    const { sourceFilename, textLength, records } = await buildRecords(
        filePath,
        method
    );

    console.log("PDF loaded:", sourceFilename);
    console.log("Chunking method:", method);
    console.log("Characters:", textLength);
    console.log("Vector records:", records.length);
    console.log("Collection:", getCollectionName(method));

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const embedding = await createEmbedding(record.document);

        await collection.upsert({
            ids: [record.id],
            embeddings: [embedding],
            documents: [record.document],
            metadatas: [record.metadata],
        });

        console.log(`Stored vector ${i + 1}/${records.length}`);
    }

    return {
        source: sourceFilename,
        chunkingMethod: method,
        collection: getCollectionName(method),
        recordsStored: records.length,
    };
}

module.exports = {
    cleanExtractedText,
    createHierarchicalChunks,
    createStandardRecords,
    getCollectionName,
    getOrCreateCollection,
    ingestDocument,
    loadPdfText,
    normalizeChunkingMethod,
    safeSplitText,
};
