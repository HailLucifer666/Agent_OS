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
  // window, sufficient for this scale).
  const buckets = new Map();
  // F6 (go-live proof plan, 2026-08-08): buckets used to grow UNBOUNDED — a
  // key was only overwritten when the same key recurred, so every distinct IP
  // added a permanent entry. Fine for a single-user desktop; on a public
  // deploy (Render) the health-check host plus crawlers add distinct IPs
  // forever. Fixed with a lazy sweep, throttled to at most once per windowMs
  // (an idle server therefore sweeps lazily on traffic, and sweep cost is
  // bounded) — expired entries are deleted when a request arrives after the
  // cadence. In-window behavior is byte-identical: a well-behaved client
  // never notices. Pinned by test/rate-limit-prune.test.js.
  let lastSweepAt = 0;

  function sweepExpired(now) {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }

  const limit = function middleware(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = `${ip}:${scope}`;
    const now = Date.now();

    // Lazy GC at a bounded cadence: at most one sweep per windowMs. Without
    // traffic nothing can grow, so sweeping only on traffic is complete.
    if (now - lastSweepAt >= windowMs) {
      lastSweepAt = now;
      sweepExpired(now);
    }

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
  };

  // Test-only seam (mirrors server._internal / createLiveSocket conventions):
  // lets test/rate-limit-prune.test.js assert the map stays bounded without
  // guessing at internals. Production never calls this.
  limit._bucketCount = () => buckets.size;
  return limit;
}

module.exports = { createLimiter };
