// ============================================================================
// utils/errors.js — Shared Error Utility
// ============================================================================

/**
 * Create an Error with an HTTP status code attached.
 * Used by all service modules for consistent error handling.
 *
 * @param {string} message - Human-readable error message.
 * @param {number} [statusCode=500] - HTTP status code.
 * @returns {Error} - Error object with statusCode property.
 */
function createServiceError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

module.exports = { createServiceError };
