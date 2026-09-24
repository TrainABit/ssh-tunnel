'use strict';

/**
 * Dashboard / API authentication.
 *
 *  - Scripts and the CLI: `Authorization: Bearer <AUTH_TOKEN>`.
 *  - The dashboard: POST /api/auth/login {token} exchanges AUTH_TOKEN for an
 *    HttpOnly, SameSite=Strict session cookie (`__Host-tv_session` over HTTPS,
 *    `tv_session` over plain HTTP) plus a per-session key returned in the JSON
 *    body ({sessionKey}). The browser never stores AUTH_TOKEN.
 *  - A cookie alone never authenticates. Every cookie-authenticated request must
 *    also present the session key: the `X-TV-Session-Key` header for HTTP
 *    requests, or a `tv-key.<sessionKey>` entry in Sec-WebSocket-Protocol for
 *    /ws/ssh upgrades (next to `tunnelvault.v1`, which the server selects). Only
 *    the dashboard origin holds the key (per-origin browser storage), whereas
 *    cookies are not isolated by port: over plain HTTP the browser also sends
 *    `tv_session` to device-controlled ports on the same host (TCP tunnels, the
 *    HTTP tunnel proxy), where a device owner could capture it.
 *  - The DB (admin_sessions) keeps only a keyed SHA-256 hash of the session id
 *    (keyed with a hash of AUTH_TOKEN so that rotating AUTH_TOKEN logs every
 *    browser session out) and a SHA-256 hash of the session key (key_hash).
 *    Rows without key_hash (created before key binding) are invalid.
 *  - Query-string tokens (?auth_token=) are NOT accepted anywhere.
 *  - Cookie-authenticated unsafe requests (POST/PUT/PATCH/DELETE) and /ws/ssh
 *    upgrades must come from our own origin (Origin header check).
 *  - Dev mode (no AUTH_TOKEN, NODE_ENV != production): everything is open.
 */
const crypto = require('crypto');
const { compileTrust } = require('./requestIp');
const { createRateLimiter } = require('./rateLimiter');
const { createLogger } = require('./logger');
const log = createLogger('auth');

const COOKIE_SECURE = '__Host-tv_session';
const COOKIE_PLAIN = 'tv_session';
/** Request header carrying the session key (HTTP requests). */
const SESSION_KEY_HEADER = 'x-tv-session-key';
/** WebSocket subprotocol the dashboard offers and the server selects on /ws/ssh. */
const WS_SUBPROTOCOL = 'tunnelvault.v1';
/** Sec-WebSocket-Protocol entry carrying the session key on /ws/ssh upgrades (never echoed). */
const WS_KEY_PROTOCOL_PREFIX = 'tv-key.';
/** Session ids and session keys: 32 random bytes, base64url = 43 chars. */
const SESSION_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_ADMIN_SESSIONS = 100;
const MAX_TOKEN_INPUT = 1024;

/** Constant-time string comparison (hash first so lengths do not leak). */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** SQLite datetime format (UTC, 'YYYY-MM-DD HH:MM:SS') so SQL comparisons with datetime('now') work. */
function sqlTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseSqlTime(value) {
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/** Split a Cookie header into [name, value] pairs, in header order (quotes removed). */
function cookiePairs(header) {
  const out = [];
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    out.push([name, value]);
  }
  return out;
}

/** Parse a Cookie header into a Map (first occurrence of a name wins). */
function parseCookies(header) {
  const out = new Map();
  for (const [name, value] of cookiePairs(header)) {
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Every value of cookie `name`, in header order. Browsers send one entry per
 * matching cookie (e.g. a host-only cookie and one with a Domain/Path set by a
 * same-site page), so callers must not trust only the first.
 */
function parseCookieValues(header, name) {
  return cookiePairs(header).filter(([n]) => n === name).map(([, v]) => v);
}

/** The session key of a request: X-TV-Session-Key header, or (upgrades) a tv-key.<key> subprotocol. */
function sessionKeyFrom(req, { upgrade = false } = {}) {
  const headers = req.headers || {};
  const header = headers[SESSION_KEY_HEADER];
  if (typeof header === 'string' && header.trim() !== '') {
    const v = header.trim();
    return SESSION_SECRET_RE.test(v) ? v : null;
  }
  if (upgrade) {
    const protocols = headers['sec-websocket-protocol'];
    if (typeof protocols === 'string') {
      for (const part of protocols.split(',')) {
        const p = part.trim();
        if (!p.startsWith(WS_KEY_PROTOCOL_PREFIX)) continue;
        const v = p.slice(WS_KEY_PROTOCOL_PREFIX.length);
        if (SESSION_SECRET_RE.test(v)) return v;
      }
    }
  }
  return null;
}

function hashSessionKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Timing-safe: sha256(key) === stored key_hash (hex). */
function sessionKeyMatches(key, keyHash) {
  if (typeof key !== 'string' || typeof keyHash !== 'string' || !/^[0-9a-f]{64}$/.test(keyHash)) return false;
  const actual = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(actual, Buffer.from(keyHash, 'hex'));
}

function firstHeader(value) {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v.split(',')[0].trim() : '';
}

/** Lower-case host[:port] with default ports stripped. */
function normalizeHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h.replace(/:(80|443)$/, '');
}

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * @param {object} opts
 * @param {object} opts.db - database module
 * @param {string} [opts.authToken] - AUTH_TOKEN ('' / undefined = dev mode unless production)
 * @param {string} [opts.nodeEnv]
 * @param {number} [opts.sessionTtlHours=12]
 * @param {*} [opts.trustProxy=false] - parsed trust proxy value (requestIp.parseTrustProxy)
 * @param {function} [opts.getClientIp] - req -> ip (defaults to req.ip / socket address)
 * @param {number} [opts.loginAttemptsPerMin=10]
 * @param {number} [opts.lastSeenThrottleMs=60000]
 */
function createAuth(opts = {}) {
  const db = opts.db;
  const authToken = typeof opts.authToken === 'string' ? opts.authToken : '';
  const nodeEnv = opts.nodeEnv || 'development';
  const authRequired = !!authToken || nodeEnv === 'production';
  const ttlHours = Number(opts.sessionTtlHours) > 0 ? Number(opts.sessionTtlHours) : 12;
  const ttlMs = Math.round(ttlHours * 3600 * 1000);
  const lastSeenThrottleMs = opts.lastSeenThrottleMs >= 0 ? opts.lastSeenThrottleMs : 60_000;
  const trust = compileTrust(opts.trustProxy === undefined ? false : opts.trustProxy);
  const getClientIp = typeof opts.getClientIp === 'function'
    ? opts.getClientIp
    : (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  // Keyed hash: sessions created under a previous AUTH_TOKEN stop validating after rotation.
  const hashKey = crypto.createHash('sha256').update(`tv-session:${authToken}`).digest();
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: opts.loginAttemptsPerMin > 0 ? opts.loginAttemptsPerMin : 10,
  });

  function hashSessionId(id) {
    return crypto.createHmac('sha256', hashKey).update(id).digest('hex');
  }

  function peerTrusted(req) {
    const addr = req.socket && req.socket.remoteAddress;
    if (!addr) return false;
    try { return !!trust(addr, 0); } catch { return false; }
  }

  /** HTTPS? Works for Express and raw (upgrade) requests; honours trust proxy. */
  function isSecure(req) {
    if (req.socket && req.socket.encrypted) return true;
    if (!peerTrusted(req)) return false;
    return firstHeader(req.headers['x-forwarded-proto']).toLowerCase() === 'https';
  }

  /** The host the client addressed (X-Forwarded-Host only from a trusted proxy). */
  function requestHost(req) {
    if (peerTrusted(req)) {
      const fwd = firstHeader(req.headers['x-forwarded-host']);
      if (fwd) return fwd;
    }
    return typeof req.headers.host === 'string' ? req.headers.host : '';
  }

  /**
   * Same-origin check. Returns true when the request carries no Origin (non-browser
   * client) or when Origin's host equals the request's own host. A Sec-Fetch-Site
   * of 'cross-site' without Origin is refused as well.
   */
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined || origin === '') {
      const site = firstHeader(req.headers['sec-fetch-site']).toLowerCase();
      return site !== 'cross-site';
    }
    let originHost;
    try {
      const u = new URL(String(origin));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      originHost = u.host;
    } catch {
      return false; // includes Origin: null
    }
    const own = normalizeHost(requestHost(req));
    return !!own && normalizeHost(originHost) === own;
  }

  function cookieNameFor(req) {
    return isSecure(req) ? COOKIE_SECURE : COOKIE_PLAIN;
  }

  function serializeCookie(req, value, maxAgeSec) {
    const parts = [`${cookieNameFor(req)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (isSecure(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function appendSetCookie(res, cookie) {
    const prev = res.getHeader('Set-Cookie');
    const list = prev === undefined ? [] : [].concat(prev);
    list.push(cookie);
    res.setHeader('Set-Cookie', list);
  }

  /**
   * Candidate session ids: every well-formed value of our cookie, de-duplicated,
   * in header order. A same-site page can plant ("toss") extra cookies with the
   * same name that the browser sends first; the first one that validates wins.
   */
  function sessionIdsFrom(req) {
    const values = parseCookieValues(req.headers.cookie, cookieNameFor(req));
    return [...new Set(values.filter((v) => SESSION_SECRET_RE.test(v)))];
  }

  /**
   * Validate the session cookie + session key. Returns { id, idHash, refreshed } or null.
   * Sliding expiry: last_seen/expires_at are refreshed at most every lastSeenThrottleMs.
   * @param {object} [opts]
   * @param {boolean} [opts.upgrade=false] - WebSocket upgrade (key may come as a subprotocol)
   */
  function validateSession(req, opts = {}) {
    if (!db) return null;
    const ids = sessionIdsFrom(req);
    if (ids.length === 0) return null;
    const key = sessionKeyFrom(req, opts);
    if (!key) return null; // a cookie on its own never authenticates
    for (const id of ids) {
      const session = checkSession(id, key);
      if (session) return session;
    }
    return null;
  }

  function checkSession(id, key) {
    const idHash = hashSessionId(id);
    let row;
    try {
      row = db.queryOne('SELECT id_hash, key_hash, expires_at, last_seen FROM admin_sessions WHERE id_hash = ?', [idHash]);
    } catch (err) {
      log.error('Session lookup failed', { error: err.message });
      return null;
    }
    if (!row) return null;
    const now = Date.now();
    const expires = parseSqlTime(row.expires_at);
    if (!Number.isFinite(expires) || expires <= now || !row.key_hash) {
      // Expired, or created before sessions were bound to a key: remove (forces a new login).
      try { db.run('DELETE FROM admin_sessions WHERE id_hash = ?', [idHash]); } catch {}
      return null;
    }
    if (!sessionKeyMatches(key, row.key_hash)) return null;
    const lastSeen = parseSqlTime(row.last_seen);
    let refreshed = false;
    if (!Number.isFinite(lastSeen) || now - lastSeen >= lastSeenThrottleMs) {
      try {
        db.run('UPDATE admin_sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?',
          [sqlTime(now), sqlTime(now + ttlMs), idHash]);
        refreshed = true;
      } catch (err) {
        log.warn('Session refresh failed', { error: err.message });
      }
    }
    return { id, idHash, refreshed };
  }

  /** New session: returns { id, key } (id goes into the cookie, key into the login response body). */
  function createSession(req) {
    const id = crypto.randomBytes(32).toString('base64url');
    const key = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : null;
    const ip = String(getClientIp(req) || '').slice(0, 64) || null;
    db.transaction(() => {
      db.run(
        'INSERT INTO admin_sessions (id_hash, key_hash, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [hashSessionId(id), hashSessionKey(key), sqlTime(now), sqlTime(now + ttlMs), sqlTime(now), ip, ua]
      );
      // Bound the table: keep the newest MAX_ADMIN_SESSIONS sessions.
      db.run(`DELETE FROM admin_sessions WHERE id_hash IN (
                SELECT id_hash FROM admin_sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
      [MAX_ADMIN_SESSIONS]);
    });
    return { id, key };
  }

  /**
   * Authenticate a request (Express or raw upgrade request).
   * Returns { ok: true, method: 'dev'|'bearer'|'cookie', session? } or
   * { ok: false, status, error, bearerFailed? }.
   * @param {object} [opts]
   * @param {boolean} [opts.upgrade=false] - WebSocket upgrade (session key may come as a subprotocol)
   */
  function authenticate(req, opts = {}) {
    if (!authRequired) return { ok: true, method: 'dev' };
    const bearer = bearerToken(req);
    if (bearer !== null) {
      if (authToken && safeCompare(bearer, authToken)) return { ok: true, method: 'bearer' };
      return { ok: false, status: 401, error: 'Invalid bearer token', bearerFailed: true };
    }
    if (authToken) {
      const session = validateSession(req, opts);
      if (session) return { ok: true, method: 'cookie', session };
    }
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  /**
   * Bearer guesses share the login rate limit (per client IP). Answers 429 and
   * returns true when the IP is already limited; only Bearer requests are checked.
   */
  function refuseLimitedBearer(req, res, ip) {
    if (bearerToken(req) === null || !limiter.isLimited(ip)) return false;
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Too many requests', message: 'Too many failed authentication attempts. Try again later.' });
    return true;
  }

  function countBearerFailure(req, result, ip) {
    if (!result.bearerFailed) return;
    limiter.hit(ip);
    log.warn('Rejected invalid bearer token', { ip, path: req.originalUrl || req.url });
  }

  /** Express middleware for /api. */
  function requireAuth(req, res, next) {
    if (!authRequired) return next();
    const ip = getClientIp(req);
    if (refuseLimitedBearer(req, res, ip)) return undefined;
    const result = authenticate(req);
    if (!result.ok) {
      countBearerFailure(req, result, ip);
      return res.status(401).json({ error: 'Unauthorized', message: 'Valid AUTH_TOKEN or dashboard session required' });
    }
    if (result.method === 'cookie') {
      if (UNSAFE_METHODS.has(req.method) && !checkOrigin(req)) {
        log.warn('Rejected cross-origin request', { ip, method: req.method, origin: String(req.headers.origin || '').slice(0, 200) });
        return res.status(403).json({ error: 'Forbidden', message: 'Cross-origin request refused' });
      }
      if (result.session.refreshed) appendSetCookie(res, serializeCookie(req, result.session.id, Math.floor(ttlMs / 1000)));
    }
    req.auth = { method: result.method };
    return next();
  }

  /**
   * Authenticate a /ws/ssh upgrade: Bearer, or cookie + session key (tv-key.<key>
   * subprotocol or X-TV-Session-Key header), plus same-origin. Returns { ok, status }.
   */
  function authenticateUpgrade(req) {
    const result = authenticate(req, { upgrade: true });
    if (!result.ok) return { ok: false, status: 401, bearerFailed: !!result.bearerFailed };
    if (authRequired && !checkOrigin(req)) return { ok: false, status: 403 };
    return { ok: true, method: result.method };
  }

  // ── Route handlers ─────────────────────────────────────
  function login(req, res) {
    if (!authRequired) return res.json({ authenticated: true, authRequired: false });
    const ip = getClientIp(req);
    if (!checkOrigin(req)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Cross-origin request refused' });
    }
    if (!limiter.hit(ip)) {
      log.warn('Login rate limited', { ip });
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests', message: 'Too many login attempts. Try again in a minute.' });
    }
    const token = req.body && req.body.token;
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_INPUT || !authToken || !safeCompare(token.trim(), authToken)) {
      log.warn('Dashboard login failed', { ip });
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
    }
    let session;
    try {
      session = createSession(req);
    } catch (err) {
      log.error('Could not create dashboard session', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    appendSetCookie(res, serializeCookie(req, session.id, Math.floor(ttlMs / 1000)));
    res.setHeader('Cache-Control', 'no-store');
    log.info('Dashboard login', { ip });
    // The key is only ever handed out here, in the body of a same-origin response.
    return res.json({ authenticated: true, authRequired: true, sessionKey: session.key });
  }

  function logout(req, res) {
    if (authRequired && !checkOrigin(req)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Cross-origin request refused' });
    }
    // Only a request holding the session key can end the session (a captured cookie cannot).
    const session = authToken ? validateSession(req) : null;
    if (session) {
      try { db.run('DELETE FROM admin_sessions WHERE id_hash = ?', [session.idHash]); } catch {}
    }
    appendSetCookie(res, serializeCookie(req, '', 0));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authenticated: false, authRequired });
  }

  function sessionStatus(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!authRequired) return res.json({ authenticated: true, authRequired: false });
    // Not an AUTH_TOKEN oracle: Bearer guesses here count against the same limit as /api.
    const ip = getClientIp(req);
    if (refuseLimitedBearer(req, res, ip)) return undefined;
    const result = authenticate(req);
    countBearerFailure(req, result, ip);
    if (result.ok && result.method === 'cookie' && result.session.refreshed) {
      appendSetCookie(res, serializeCookie(req, result.session.id, Math.floor(ttlMs / 1000)));
    }
    return res.json({ authenticated: !!result.ok, authRequired: true });
  }

  /** Delete expired dashboard sessions. Returns the number removed. */
  function cleanupExpiredSessions() {
    if (!db) return 0;
    try {
      return db.run("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").changes;
    } catch (err) {
      log.warn('Admin session cleanup failed', { error: err.message });
      return 0;
    }
  }

  return {
    authRequired,
    requireAuth,
    authenticate,
    authenticateUpgrade,
    checkOrigin,
    isSecure,
    login,
    logout,
    sessionStatus,
    cleanupExpiredSessions,
    limiter,
    destroy() { limiter.destroy(); },
  };
}

module.exports = {
  createAuth,
  safeCompare,
  parseCookies,
  parseCookieValues,
  bearerToken,
  COOKIE_SECURE,
  COOKIE_PLAIN,
  SESSION_KEY_HEADER,
  WS_SUBPROTOCOL,
  WS_KEY_PROTOCOL_PREFIX,
};
