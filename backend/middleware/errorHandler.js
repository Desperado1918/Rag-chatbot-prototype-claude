// ============================================================================
// middleware/errorHandler.js — Centralized Express 5 Error Handler
// ============================================================================
// Express 5 automatically forwards rejected promises from async route handlers
// to error middleware. This handler catches everything and returns a consistent
// JSON error shape.
// ============================================================================

/**
 * Centralized error-handling middleware.
 * Must be registered as the LAST middleware in server.js.
 *
 * Consistent error shape:
 *   { error: string, code?: string, details?: any }
 */
function errorHandler(err, req, res, _next) {
    // Determine HTTP status code
    const statusCode = err.statusCode || err.status || 500;

    // Log the error
    if (req.log) {
        // pino logger attached by pino-http
        req.log.error({ err, statusCode }, err.message);
    } else {
        console.error(`[Error] ${statusCode} — ${err.message}`);
        if (statusCode === 500) {
            console.error(err.stack);
        }
    }

    // Build response body
    const body = {
        error: err.message || "Internal server error",
    };

    if (err.code) {
        body.code = err.code;
    }

    // Include validation details in development
    if (err.details) {
        body.details = err.details;
    }

    res.status(statusCode).json(body);
}

module.exports = errorHandler;
