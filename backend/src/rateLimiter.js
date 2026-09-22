/**
 * Fixed-window in-memory rate limiter keyed by an arbitrary string (usually an IP).
 *
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
 *   if (!limiter.hit(ip)) return reject429();
 *
 * Call destroy() on shutdown to clear the cleanup timer.
 */
function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const buckets = new Map(); // key -> { windowStart, count }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.windowStart >= windowMs) buckets.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    /** Count one hit for key. Returns true if still within the limit. */
    hit(key) {
      const k = String(key || 'unknown');
      const now = Date.now();
      const entry = buckets.get(k);
      if (!entry || now - entry.windowStart >= windowMs) {
        buckets.set(k, { windowStart: now, count: 1 });
        return max >= 1;
      }
      entry.count++;
      return entry.count <= max;
    },

    /** True if key has already exceeded the limit (does not count a hit). */
    isLimited(key) {
      const entry = buckets.get(String(key || 'unknown'));
      return !!entry && Date.now() - entry.windowStart < windowMs && entry.count >= max;
    },

    /** Forget a key (e.g. after a successful login). */
    reset(key) {
      buckets.delete(String(key || 'unknown'));
    },

    destroy() {
      clearInterval(cleanup);
      buckets.clear();
    },
  };
}

module.exports = { createRateLimiter };
