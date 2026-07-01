// ============================================================================
// utils/timer.js — High-Resolution Async Timer
// ============================================================================

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
        durationMs: Number((end - start).toFixed(2)),
    };
}

module.exports = { timedExecution };
