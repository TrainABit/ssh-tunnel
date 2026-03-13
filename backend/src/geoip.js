const http = require('http');

const PRIVATE_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|^$|unknown)/i;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

const cache = new Map();

function evictOldest() {
  let oldestKey = null, oldestTime = Infinity;
  for (const [k, v] of cache) {
    if (v.cachedAt < oldestTime) { oldestTime = v.cachedAt; oldestKey = k; }
  }
  if (oldestKey) cache.delete(oldestKey);
}

async function lookupGeo(ip) {
  if (!ip || PRIVATE_RE.test(ip)) return null;

  const now = Date.now();
  const cached = cache.get(ip);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.result;

  return new Promise((resolve) => {
    const req = http.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city`,
      { timeout: 3000 },
      (res) => {
        let raw = '';
        res.on('data', d => { raw += d; });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            const result = json.status === 'success'
              ? { country: json.country, country_code: json.countryCode, city: json.city }
              : null;
            if (cache.size >= CACHE_MAX) evictOldest();
            cache.set(ip, { result, cachedAt: Date.now() });
            resolve(result);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

module.exports = { lookupGeo };
