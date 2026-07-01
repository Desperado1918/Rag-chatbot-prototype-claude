// ============================================================================
// middleware/cache.js — Simple In-Memory LRU Cache
// ============================================================================
// Caches API responses (like the conversation list) to improve performance.
// Includes invalidation hooks.
// ============================================================================

const cache = new Map();

/**
 * Middleware to cache HTTP GET responses.
 * @param {number} ttl - Time to live in milliseconds
 */
function cacheMiddleware(ttl = 60000) {
    return (req, res, next) => {
        // Only cache GET requests
        if (req.method !== "GET") {
            return next();
        }

        const key = req.originalUrl;
        const cached = cache.get(key);

        if (cached && Date.now() < cached.expiresAt) {
            return res.json(cached.data);
        }

        // Override res.json to capture the response data
        const originalJson = res.json.bind(res);
        res.json = (data) => {
            cache.set(key, {
                data,
                expiresAt: Date.now() + ttl,
            });
            originalJson(data);
        };

        next();
    };
}

/**
 * Clear the entire cache or a specific key prefix.
 * @param {string} [prefix] - Optional prefix to match keys against.
 */
function invalidateCache(prefix) {
    if (!prefix) {
        cache.clear();
        return;
    }

    const keysToDelete = [];
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            keysToDelete.push(key);
        }
    }
    for (const key of keysToDelete) {
        cache.delete(key);
    }
}

module.exports = {
    cacheMiddleware,
    invalidateCache,
};
