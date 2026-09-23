'use strict';

/**
 * Optional GeoIP lookups for session rows.
 *
 *   GEOIP_PROVIDER=off      (default) no lookups at all
 *   GEOIP_PROVIDER=maxmind  local lookups in a GeoLite2/GeoIP2 City .mmdb file (GEOIP_DB=/path/GeoLite2-City.mmdb)
 *   GEOIP_PROVIDER=ip-api   legacy: every visitor IP is sent to ip-api.com over plain HTTP
 *                           (free tier is for non-commercial use only)
 * GEOIP_DB set and GEOIP_PROVIDER unset -> maxmind.
 *
 * lookupGeo(ip) -> Promise<{ country, country_code, city } | null> (never rejects).
 */
const http = require('http');
const net = require('net');
const { createLogger } = require('./logger');
const log = createLogger('geoip');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const PROVIDERS = new Set(['off', 'maxmind', 'ip-api']);

let state = null; // { provider, dbPath, readerPromise, cache }

function resolveProvider(env = process.env) {
  const raw = String(env.GEOIP_PROVIDER || '').trim().toLowerCase();
  const dbPath = String(env.GEOIP_DB || '').trim();
  if (!raw) return { provider: dbPath ? 'maxmind' : 'off', dbPath };
  if (raw === 'none' || raw === 'false' || raw === '0' || raw === 'disabled') return { provider: 'off', dbPath };
  if (raw === 'ipapi' || raw === 'ip-api.com') return { provider: 'ip-api', dbPath };
  if (!PROVIDERS.has(raw)) {
    log.warn('Unknown GEOIP_PROVIDER — GeoIP disabled', { provider: raw });
    return { provider: 'off', dbPath };
  }
  return { provider: raw, dbPath };
}

/**
 * (Re)configure from the environment (called at startup; also lazily on the
 * first lookup). Returns the effective provider name.
 */
function initGeoip(env = process.env) {
  const { provider, dbPath } = resolveProvider(env);
  state = { provider, dbPath, readerPromise: null, cache: new Map() };

  if (provider === 'maxmind') {
    if (!dbPath) {
      log.error('GEOIP_PROVIDER=maxmind requires GEOIP_DB=/path/to/GeoLite2-City.mmdb — GeoIP disabled');
      state.provider = 'off';
    } else {
      const current = state;
      let maxmind;
      try {
        maxmind = require('maxmind');
      } catch (err) {
        log.error('The maxmind package is not installed — GeoIP disabled', { error: err.message });
        state.provider = 'off';
      }
      if (maxmind) {
        current.readerPromise = maxmind
          .open(dbPath, { watchForUpdates: true, watchForUpdatesNonPersistent: true })
          .then((reader) => {
            log.info('MaxMind GeoIP database loaded', { path: dbPath });
            return reader;
          })
          .catch((err) => {
            log.error('Cannot open GEOIP_DB — GeoIP disabled', { path: dbPath, error: err.message });
            current.provider = 'off';
            return null;
          });
      }
    }
  } else if (provider === 'ip-api') {
    log.warn('GEOIP_PROVIDER=ip-api sends every visitor IP to ip-api.com over plain HTTP. '
      + 'The free tier forbids commercial use and this is a GDPR data transfer; '
      + 'prefer GEOIP_PROVIDER=maxmind with a local GeoLite2 database.');
  }
  return state.provider;
}

function getGeoipProvider() {
  if (!state) initGeoip();
  return state.provider;
}

/** Strip IPv4-mapped IPv6 prefix and zone ids. */
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  let s = ip.trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  const pct = s.indexOf('%');
  if (pct > 0) s = s.slice(0, pct);
  return net.isIP(s) ? s : null;
}

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

function cacheGet(ip) {
  const hit = state.cache.get(ip);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit;
  return null;
}

function cacheSet(ip, result) {
  if (state.cache.size >= CACHE_MAX) {
    // Map iteration order = insertion order: drop the oldest entry
    const oldest = state.cache.keys().next().value;
    state.cache.delete(oldest);
  }
  state.cache.set(ip, { result, cachedAt: Date.now() });
}

function lookupIpApi(ip) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city`,
      { timeout: 3000 },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          raw += d;
          if (raw.length > 16 * 1024) req.destroy();
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            resolve(json.status === 'success'
              ? { country: json.country || null, country_code: json.countryCode || null, city: json.city || null }
              : null);
          } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function lookupMaxmind(ip) {
  const reader = state.readerPromise ? await state.readerPromise : null;
  if (!reader) return null;
  let rec = null;
  try {
    rec = reader.get(ip);
  } catch {
    return null;
  }
  if (!rec) return null;
  const country = rec.country || rec.registered_country || null;
  const result = {
    country: (country && country.names && country.names.en) || null,
    country_code: (country && country.iso_code) || null,
    city: (rec.city && rec.city.names && rec.city.names.en) || null,
  };
  return result.country || result.country_code || result.city ? result : null;
}

async function lookupGeo(ip) {
  try {
    if (!state) initGeoip();
    if (state.provider === 'off') return null;
    const addr = normalizeIp(ip);
    if (!addr || isPrivateIp(addr)) return null;
    if (state.provider === 'maxmind') return await lookupMaxmind(addr);

    const cached = cacheGet(addr);
    if (cached) return cached.result;
    const result = await lookupIpApi(addr);
    cacheSet(addr, result);
    return result;
  } catch {
    return null;
  }
}

module.exports = { lookupGeo, initGeoip, getGeoipProvider, normalizeIp, isPrivateIp, resolveProvider };
