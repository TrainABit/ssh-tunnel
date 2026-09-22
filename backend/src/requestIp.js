const proxyaddr = require('proxy-addr');

/**
 * Parse the TRUST_PROXY / BEHIND_PROXY environment into an Express
 * "trust proxy" value. Proxy headers (X-Forwarded-For etc.) are only honoured
 * when the operator explicitly says a reverse proxy sits in front of us —
 * otherwise any client could spoof its IP and dodge rate limits.
 *
 *   unset / "false" / "0"   -> false (trust nobody, use the socket address)
 *   "true" / "loopback"     -> "loopback" (Nginx/Caddy on the same host)
 *   "2"                     -> 2 (number of trusted hops)
 *   "10.0.0.0/8,127.0.0.1"  -> list of trusted proxy addresses/subnets
 *
 * BEHIND_PROXY=true is accepted as an alias for TRUST_PROXY=loopback.
 */
function parseTrustProxy(env = process.env) {
  let raw = (env.TRUST_PROXY || '').trim();
  if (!raw && /^(1|true|yes)$/i.test((env.BEHIND_PROXY || '').trim())) raw = 'loopback';
  if (!raw || /^(0|false|no|off)$/i.test(raw)) return false;
  if (/^(true|yes|on)$/i.test(raw)) return 'loopback';
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Compile a trust value (as returned by parseTrustProxy) into a function
 * usable by proxy-addr. Mirrors Express's own compileTrust().
 */
function compileTrust(value) {
  if (typeof value === 'function') return value;
  if (value === false || value === undefined || value === null) return () => false;
  if (value === true) return () => true;
  if (typeof value === 'number') return (_addr, i) => i < value;
  return proxyaddr.compile(value);
}

/**
 * Create a resolver that returns the client IP for a raw Node request
 * (e.g. a WebSocket upgrade request, which never passes through Express).
 */
function createIpResolver(trustValue) {
  const trust = compileTrust(trustValue);
  return function getClientIp(req) {
    try {
      return proxyaddr(req, trust) || req.socket?.remoteAddress || 'unknown';
    } catch {
      return req.socket?.remoteAddress || 'unknown';
    }
  };
}

module.exports = { parseTrustProxy, compileTrust, createIpResolver };
