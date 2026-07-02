// ============================================================================
// middleware/validate.js — Zod Validation Middleware Factory
// ============================================================================
// Creates Express middleware that validates request body (or query/params)
// against a Zod schema. Returns 400 with structured error details on failure.
// ============================================================================

const { createServiceError } = require("../utils/errors");

/**
 * Create validation middleware for a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against.
 * @param {'body' | 'query' | 'params'} [source='body'] - Which part of the request to validate.
 * @returns {Function} Express middleware function.
 *
 * @example
 *   const { z } = require('zod');
 *   const createChatSchema = z.object({ title: z.string().optional() });
 *   router.post('/', validate(createChatSchema), controller.createChat);
 */
function validate(schema, source = "body") {
    return (req, _res, next) => {
        const result = schema.safeParse(req[source]);

        if (!result.success) {
            const error = createServiceError("Validation failed", 400);
            error.code = "VALIDATION_ERROR";
            error.details = result.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
            }));
            return next(error);
        }

        // Replace the source with the parsed (coerced/defaulted) data
        req[source] = result.data;
        next();
    };
}

module.exports = validate;
