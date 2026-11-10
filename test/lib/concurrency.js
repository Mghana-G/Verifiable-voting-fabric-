'use strict';

// Bounded-concurrency map: at most `limit` calls to fn() in flight at once,
// results returned in input order regardless of completion order. Shared by
// test3 (mint phase) and test7 (mint phase, and the bounded-concurrency cast
// probe) — see docs/DEVIATIONS.md DEV-005.
async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

module.exports = { mapConcurrent };
