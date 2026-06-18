// ============================================================================
// benchmark.js — 100% Local End-to-End RAG Benchmarking Suite
// ============================================================================
// Compares "standard" vs "hierarchical" chunking methods across:
//   1. Ingestion Time (ms) — parse + chunk + embed + store
//   2. Query Latency (ms) — average time to retrieve vectors from ChromaDB
//   3. Average Cosine Similarity Score — mean of top-K hit similarities
//   4. Deduplication Rate — child→parent collapse ratio (hierarchical only)
//
// Runs 100% locally using Ollama + ChromaDB. No cloud APIs.
// ============================================================================

const { ChromaClient } = require("chromadb");
const {
    ingestDocument,
    loadPdfText,
    getCollectionName,
    normalizeChunkingMethod,
    safeSplitText,
    createEmbedding,
    PARENT_CHUNK_SIZE,
    CHILD_CHUNK_SIZE,
    STANDARD_CHUNK_SIZE,
    DOCUMENT_PATH
} = require("./ingest");

const {
    SIMILARITY_THRESHOLD,
    retrieveVectorHits,
    applySimilarityGate,
    distanceToSimilarity
} = require("./query");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHROMA_URL = "http://localhost:8000";

// Default test queries based on the "Retrieval-Augmented Generation for
// Knowledge-Intensive NLP Tasks" (Lewis et al., 2020) paper.
const DEFAULT_TEST_QUERIES = [
    "What is Retrieval-Augmented Generation?",
    "How does the RAG-Sequence model differ from the RAG-Token model?",
    "What retriever does RAG use and how is it trained?",
    "What datasets were used to evaluate RAG?",
    "How does RAG handle knowledge updates without retraining?"
];

// The two chunking methods to benchmark against each other
const METHODS = ["standard", "hierarchical"];

// ---------------------------------------------------------------------------
// Utility: High-Resolution Timer
// ---------------------------------------------------------------------------

/**
 * Measure the execution time of an async function in milliseconds.
 * Uses performance.now() for sub-millisecond accuracy.
 *
 * @param {Function} asyncFn - Async function to measure.
 * @returns {Promise<{ result: any, durationMs: number }>}
 */
async function timedExecution(asyncFn) {
    const start = performance.now();
    const result = await asyncFn();
    const end = performance.now();

    return {
        result,
        durationMs: Number((end - start).toFixed(2))
    };
}

// ---------------------------------------------------------------------------
// Benchmark: Ingestion Time
// ---------------------------------------------------------------------------

/**
 * Delete any existing collection for this method, then run a full ingestion
 * pipeline (parse → chunk → embed → store) and time the entire process.
 *
 * @param {string} method - "standard" or "hierarchical"
 * @returns {Promise<Object>} - { durationMs, recordCount }
 */
async function benchmarkIngestion(method) {
    const collectionName = getCollectionName(method);
    console.log(`\n  [Ingestion] Deleting existing collection "${collectionName}"...`);

    // Clean slate: delete the collection if it exists
    const client = new ChromaClient({ path: CHROMA_URL });
    try {
        await client.deleteCollection({ name: collectionName });
        console.log(`  [Ingestion] Deleted existing collection.`);
    } catch (error) {
        console.log(`  [Ingestion] No existing collection to delete.`);
    }

    // Time the full ingestion pipeline
    console.log(`  [Ingestion] Starting full ingestion with "${method}" chunking...`);
    const { result, durationMs } = await timedExecution(async () => {
        return await ingestDocument(DOCUMENT_PATH, { chunkingMethod: method });
    });

    console.log(`  [Ingestion] Completed in ${durationMs}ms. Records stored: ${result.recordsStored}`);

    return {
        durationMs,
        recordCount: result.recordsStored
    };
}

// ---------------------------------------------------------------------------
// Benchmark: Query Latency + Similarity Scores + Deduplication
// ---------------------------------------------------------------------------

/**
 * Run all test queries against a chunking method's collection and collect:
 *   - Per-query retrieval latency (ms)
 *   - Per-query similarity scores of all hits
 *   - Per-query deduplication stats (hierarchical only)
 *
 * @param {string} method - "standard" or "hierarchical"
 * @param {string[]} queries - Test queries to evaluate.
 * @returns {Promise<Object>} - Query benchmark results.
 */
async function benchmarkQueries(method, queries) {
    const queryResults = [];

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        console.log(`  [Query ${i + 1}/${queries.length}] "${query.slice(0, 60)}..."`);

        // Time just the vector retrieval (not LLM generation)
        const { result: rawHits, durationMs } = await timedExecution(async () => {
            return await retrieveVectorHits(query, method);
        });

        // Apply similarity gate
        const filteredHits = applySimilarityGate(rawHits);

        // Collect similarity scores for all raw hits
        const allSimilarities = rawHits
            .map((hit) => hit.similarity)
            .filter((s) => typeof s === "number");

        // Calculate deduplication rate for hierarchical method
        let dedupStats = null;
        if (method === "hierarchical" && filteredHits.length > 0) {
            const parentIds = new Set();
            for (const hit of filteredHits) {
                if (hit.metadata.parentId) {
                    parentIds.add(hit.metadata.parentId);
                }
            }

            const childCount = filteredHits.length;
            const uniqueParentCount = parentIds.size;
            const dedupRate = childCount > 0
                ? Number(((1 - uniqueParentCount / childCount) * 100).toFixed(1))
                : 0;

            dedupStats = {
                childHits: childCount,
                uniqueParents: uniqueParentCount,
                dedupRate
            };
        }

        queryResults.push({
            query,
            latencyMs: durationMs,
            rawHitCount: rawHits.length,
            filteredHitCount: filteredHits.length,
            similarities: allSimilarities,
            avgSimilarity: allSimilarities.length > 0
                ? Number((allSimilarities.reduce((a, b) => a + b, 0) / allSimilarities.length).toFixed(4))
                : 0,
            dedupStats
        });

        console.log(
            `    Latency: ${durationMs}ms | Hits: ${filteredHits.length}/${rawHits.length} passed gate | ` +
            `Avg similarity: ${queryResults[queryResults.length - 1].avgSimilarity}`
        );
    }

    return queryResults;
}

// ---------------------------------------------------------------------------
// Aggregate Statistics
// ---------------------------------------------------------------------------

/**
 * Compute aggregate statistics from individual query benchmark results.
 *
 * @param {Object[]} queryResults - Array of per-query results.
 * @returns {Object} - Aggregated stats.
 */
function aggregateStats(queryResults) {
    const latencies = queryResults.map((r) => r.latencyMs);
    const similarities = queryResults.flatMap((r) => r.similarities);
    const dedupRates = queryResults
        .filter((r) => r.dedupStats !== null)
        .map((r) => r.dedupStats.dedupRate);

    return {
        avgLatencyMs: latencies.length > 0
            ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2))
            : 0,
        minLatencyMs: latencies.length > 0 ? Number(Math.min(...latencies).toFixed(2)) : 0,
        maxLatencyMs: latencies.length > 0 ? Number(Math.max(...latencies).toFixed(2)) : 0,
        avgSimilarityScore: similarities.length > 0
            ? Number((similarities.reduce((a, b) => a + b, 0) / similarities.length).toFixed(4))
            : 0,
        avgDeduplicationRate: dedupRates.length > 0
            ? `${(dedupRates.reduce((a, b) => a + b, 0) / dedupRates.length).toFixed(1)}%`
            : "N/A"
    };
}

// ---------------------------------------------------------------------------
// Console Table Formatter
// ---------------------------------------------------------------------------

/**
 * Print a comparison table of benchmark results to the console.
 * Formats both methods side-by-side for easy scanning.
 *
 * @param {Object} benchmarkData - The full benchmark results object.
 */
function printComparisonTable(benchmarkData) {
    const methods = Object.keys(benchmarkData.methods);

    console.log("\n" + "=".repeat(80));
    console.log("  BENCHMARK COMPARISON TABLE");
    console.log("=".repeat(80));

    // Header row
    const headerRow = [
        "Metric".padEnd(30),
        ...methods.map((m) => m.toUpperCase().padStart(20))
    ].join(" | ");

    console.log(`| ${headerRow} |`);
    console.log(`|${"-".repeat(32)}|${methods.map(() => "-".repeat(22)).join("|")}|`);

    // Data rows
    const rows = [
        {
            label: "Total Chunks",
            values: methods.map((m) => benchmarkData.methods[m].ingestion.totalChunks.toString())
        },
        {
            label: "Ingestion Time (ms)",
            values: methods.map((m) => benchmarkData.methods[m].ingestion.ingestionTimeMs.toString())
        },
        {
            label: "Avg Query Latency (ms)",
            values: methods.map((m) => benchmarkData.methods[m].queryResults.avgLatencyMs.toString())
        },
        {
            label: "Min Query Latency (ms)",
            values: methods.map((m) => benchmarkData.methods[m].queryResults.minLatencyMs.toString())
        },
        {
            label: "Max Query Latency (ms)",
            values: methods.map((m) => benchmarkData.methods[m].queryResults.maxLatencyMs.toString())
        },
        {
            label: "Avg Cosine Similarity",
            values: methods.map((m) => benchmarkData.methods[m].queryResults.avgSimilarityScore.toString())
        },
        {
            label: "Deduplication Rate",
            values: methods.map((m) => benchmarkData.methods[m].queryResults.avgDeduplicationRate)
        }
    ];

    for (const row of rows) {
        const cells = [
            row.label.padEnd(30),
            ...row.values.map((v) => v.padStart(20))
        ].join(" | ");

        console.log(`| ${cells} |`);
    }

    console.log("=".repeat(80));
}

/**
 * Print per-query details for deeper analysis.
 *
 * @param {Object} benchmarkData - The full benchmark results object.
 */
function printPerQueryDetails(benchmarkData) {
    console.log("\n" + "=".repeat(80));
    console.log("  PER-QUERY DETAILS");
    console.log("=".repeat(80));

    const queries = DEFAULT_TEST_QUERIES;

    for (let i = 0; i < queries.length; i++) {
        console.log(`\n  Q${i + 1}: "${queries[i]}"`);
        console.log(`  ${"—".repeat(70)}`);

        for (const method of METHODS) {
            const methodData = benchmarkData.methods[method];
            const qr = methodData.perQueryResults[i];

            if (!qr) continue;

            const dedupInfo = qr.dedupStats
                ? ` | Dedup: ${qr.dedupStats.childHits} children → ${qr.dedupStats.uniqueParents} parents (${qr.dedupStats.dedupRate}%)`
                : "";

            console.log(
                `    [${method.toUpperCase().padEnd(13)}] ` +
                `Latency: ${qr.latencyMs.toString().padStart(8)}ms | ` +
                `Hits: ${qr.filteredHitCount}/${qr.rawHitCount} | ` +
                `Avg Sim: ${qr.avgSimilarity}${dedupInfo}`
            );
        }
    }
}

// ============================================================================
// Main Benchmark Runner
// ============================================================================

/**
 * Run the complete benchmark suite:
 *   1. Ingest the document with both methods (timed)
 *   2. Run all test queries against both methods (timed, scored)
 *   3. Compute aggregate statistics
 *   4. Output results as both console table and JSON
 */
async function runBenchmark() {
    console.log("=".repeat(80));
    console.log("  RAG CHUNKING BENCHMARK SUITE — 100% LOCAL");
    console.log("=".repeat(80));
    console.log(`  Document:    ${DOCUMENT_PATH}`);
    console.log(`  Methods:     ${METHODS.join(", ")}`);
    console.log(`  Test Queries: ${DEFAULT_TEST_QUERIES.length}`);
    console.log(`  Threshold:   >= ${SIMILARITY_THRESHOLD} cosine similarity`);
    console.log(`  Chunk Sizes: standard=${STANDARD_CHUNK_SIZE}, parent=${PARENT_CHUNK_SIZE}, child=${CHILD_CHUNK_SIZE}`);
    console.log("=".repeat(80));

    const benchmarkData = {
        document: DOCUMENT_PATH,
        timestamp: new Date().toISOString(),
        similarityThreshold: SIMILARITY_THRESHOLD,
        testQueryCount: DEFAULT_TEST_QUERIES.length,
        methods: {}
    };

    // -----------------------------------------------------------------------
    // Phase 1: Ingestion Benchmark
    // -----------------------------------------------------------------------
    for (const method of METHODS) {
        console.log(`\n${"━".repeat(80)}`);
        console.log(`  PHASE 1: INGESTING with "${method}" method`);
        console.log(`${"━".repeat(80)}`);

        const ingestionResult = await benchmarkIngestion(method);

        benchmarkData.methods[method] = {
            ingestion: {
                ingestionTimeMs: ingestionResult.durationMs,
                totalChunks: ingestionResult.recordCount
            }
        };
    }

    // -----------------------------------------------------------------------
    // Phase 2: Query Benchmark
    // -----------------------------------------------------------------------
    for (const method of METHODS) {
        console.log(`\n${"━".repeat(80)}`);
        console.log(`  PHASE 2: QUERYING with "${method}" method`);
        console.log(`${"━".repeat(80)}`);

        const queryResults = await benchmarkQueries(method, DEFAULT_TEST_QUERIES);
        const aggregated = aggregateStats(queryResults);

        benchmarkData.methods[method].queryResults = aggregated;
        benchmarkData.methods[method].perQueryResults = queryResults;
    }

    // -----------------------------------------------------------------------
    // Phase 3: Output Results
    // -----------------------------------------------------------------------

    // Console table for quick scanning
    printComparisonTable(benchmarkData);

    // Per-query details for deeper analysis
    printPerQueryDetails(benchmarkData);

    // Clean JSON output (strip per-query details for the JSON to keep it scannable)
    const jsonOutput = {
        benchmark: {
            document: benchmarkData.document,
            timestamp: benchmarkData.timestamp,
            similarityThreshold: benchmarkData.similarityThreshold,
            testQueryCount: benchmarkData.testQueryCount,
            methods: {}
        }
    };

    for (const method of METHODS) {
        const md = benchmarkData.methods[method];
        jsonOutput.benchmark.methods[method] = {
            ingestionTimeMs: md.ingestion.ingestionTimeMs,
            totalChunks: md.ingestion.totalChunks,
            queryResults: {
                avgLatencyMs: md.queryResults.avgLatencyMs,
                avgSimilarityScore: md.queryResults.avgSimilarityScore,
                deduplicationRate: md.queryResults.avgDeduplicationRate
            }
        };
    }

    console.log("\n" + "=".repeat(80));
    console.log("  BENCHMARK RESULTS (JSON)");
    console.log("=".repeat(80));
    console.log(JSON.stringify(jsonOutput, null, 2));
    console.log("=".repeat(80));

    return jsonOutput;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
    runBenchmark()
        .then(() => {
            console.log("\nBenchmark complete.");
            process.exit(0);
        })
        .catch((error) => {
            console.error("\nBenchmark failed:", error.message);
            console.error(error.stack);
            process.exit(1);
        });
}

module.exports = { runBenchmark };
