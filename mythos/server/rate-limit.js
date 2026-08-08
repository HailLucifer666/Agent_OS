// rate-limit.js — zero-dependency token-bucket rate limiter for Express.
//
// In-memory, per-key (IP + optional scope) token bucket. Designed for a single
// localhost process — not a distributed limiter. Two tiers are wired in server/index.js:
//   - global: 240 req/min across /api/*
//   - expensive: 8 req/min on routes that shell out or call LLMs
// Returns 429 { error, retryAfter } with a Retry-After header when exhausted.
//
// Honesty rule: exhausted requests are logged at warn level by the caller, never
// silently dropped — the user deserves to see when they're being throttled.

/**
 * Create a rate-limiter middleware factory.
 *
 * @param {object} opts
 * @param {number} opts.windowMs  - refill window (e.g. 60000 for 1 min)
 * @param {number} opts.max       - max requests per window per key
 * @param {string} [opts.scope]   - logical name for this tier (logged on exhaustion)
 * @returns {Function} Express middleware
 */
function createLimiter({ windowMs, max, scope = 'default' }) {
  // Map<key, { count, resetAt }>. Fixed-window counters (simpler than sliding
  // window, sufficient for this scale). A stale entry for a key that never
  // comes back is never overwritten — H12: on an always-on process, every
  // distinct client IP permanently grows this Map. Evicted opportunistically
  // on access below (no timer, so it never keeps the process alive) rather
  // than by a background sweep.
  const buckets = new Map();
  let lastSweepAt = 0;

  // Throttled to once per windowMs so it never becomes an O(n) tax on every
  // single request under heavy traffic — only entries past their own reset
  // are ever removed, so no live bucket is disturbed early.
  function evictExpired(now) {
    if (now - lastSweepAt < windowMs) return;
    lastSweepAt = now;
    buckets.forEach((bucket, k) => {
      if (now >= bucket.resetAt) buckets.delete(k);
    });
  }

  function limit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = `${ip}:${scope}`;
    const now = Date.now();

    evictExpired(now);

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      // Attach context for the request logger / error middleware to surface.
      req.rateLimited = { scope, retryAfterSec, count: bucket.count, max };
      return res.status(429).json({
        error: `Rate limit exceeded for ${scope}. Try again in ${retryAfterSec}s.`,
        retryAfter: retryAfterSec,
      });
    }

    next();
  }

  // Test-only introspection — mirrors the `_internal` convention used
  // elsewhere in this repo (e.g. aether/scanner-proxy.js) rather than adding
  // a real public API surface just to observe eviction.
  limit._internal = { buckets, evictExpired };
  return limit;
}

module.exports = { createLimiter };
