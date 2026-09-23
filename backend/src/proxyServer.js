const http = require('http');
const https = require('https');
const fs = require('fs');
const { createLogger } = require('./logger');
const { compileTrust } = require('./requestIp');
const { isUuid, openTunnelStream, spliceSocket } = require('./protocol');
const { normalizeDomain } = require('./tunnelManager');
const log = createLogger('proxy');

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 60_000;

// Hop-by-hop headers (RFC 9110 §7.6.1) plus legacy proxy headers.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// Response headers a tunnelled app must not set for our domain.
const BLOCKED_RESPONSE_HEADERS = new Set([
  'strict-transport-security', 'public-key-pins', 'public-key-pins-report-only',
]);
// Request headers we (re)generate ourselves.
const FORWARDING_HEADERS = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded']);

/** Host header -> lower-case hostname without port / trailing dot ('' if invalid). */
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(0, end + 1) : '';
  }
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host.replace(/\.$/, '');
}

/** Remove every Domain= attribute so cookies stay host-only. */
function stripCookieDomain(cookie) {
  const parts = String(cookie).split(';');
  const kept = [parts[0].trim()];
  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i].trim();
    if (!attr) continue;
    const name = attr.split('=')[0].trim().toLowerCase();
    if (name === 'domain') continue;
    kept.push(attr);
  }
  return kept.join('; ');
}

function connectionTokens(value) {
  const out = new Set();
  if (!value) return out;
  for (const v of [].concat(value)) {
    for (const token of String(v).split(',')) {
      const t = token.trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return out;
}

/** Filter response headers from the device (object form from IncomingMessage.headers). */
function filterResponseHeaders(headers) {
  const listed = connectionTokens(headers.connection);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || listed.has(name) || BLOCKED_RESPONSE_HEADERS.has(name)) continue;
    if (name === 'set-cookie') {
      out[name] = [].concat(value).map(stripCookieDomain);
      continue;
    }
    out[name] = value;
  }
  return out;
}

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_BAD_RE = /[\r\n\0]/;

/**
 * Raw response head for an upgrade request (written straight to the client
 * socket). Same header rules as filterResponseHeaders; for a 101 the
 * Connection/Upgrade headers are kept, otherwise the connection is closed
 * after the (already de-chunked) body.
 */
function serializeResponseHead(proxyRes, upgraded) {
  const reason = String(proxyRes.statusMessage || '').replace(/[^\t\x20-\x7e]/g, '');
  const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${reason}`.trimEnd()];
  const listed = connectionTokens(proxyRes.headers.connection);
  const raw = proxyRes.rawHeaders || [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = String(raw[i]);
    let value = String(raw[i + 1]);
    const lower = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name) || HEADER_VALUE_BAD_RE.test(value)) continue;
    if (BLOCKED_RESPONSE_HEADERS.has(lower)) continue;
    const keepForUpgrade = upgraded && (lower === 'connection' || lower === 'upgrade');
    if (!keepForUpgrade && (HOP_BY_HOP.has(lower) || listed.has(lower))) continue;
    if (lower === 'set-cookie') value = stripCookieDomain(value);
    lines.push(`${name}: ${value}`);
  }
  if (!upgraded) lines.push('Connection: close');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function rejectRaw(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

/**
 * Create the proxy server that receives inbound HTTP requests for http
 * tunnels and streams them to the device over a tunnel stream (tcp-open to
 * the tunnel's localPort), with backpressure and WebSocket upgrade passthrough.
 *
 * Routing: Host header "<subdomain>.<DOMAIN>" (only hosts under DOMAIN), or
 * the `?tunnel=<id>` query parameter for hosts outside DOMAIN (e.g. a bare IP;
 * all tunnels then share one origin, so this is meant for testing only).
 *
 * @param {TunnelManager} tunnelManager
 * @param {ConnectionTracker} connectionTracker
 * @param {object} [options] - { tcpProxy, getClientIp, trustProxy, domain, idleTimeoutMs }
 * @returns {http.Server|https.Server}
 */
function createProxyServer(tunnelManager, connectionTracker, options = {}) {
  const domain = normalizeDomain(options.domain || process.env.DOMAIN);
  const domainSuffix = `.${domain}`;
  const idleTimeoutMs = options.idleTimeoutMs > 0
    ? options.idleTimeoutMs
    : (parseInt(process.env.HTTP_PROXY_IDLE_TIMEOUT_MS, 10) || DEFAULT_IDLE_TIMEOUT_MS);
  const isTrustedPeer = compileTrust(options.trustProxy === undefined ? false : options.trustProxy);
  const getClientIp = typeof options.getClientIp === 'function'
    ? options.getClientIp
    : (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
  const tcpProxy = options.tcpProxy || null;

  function resolveTunnel(req) {
    const hostname = hostnameOf(req.headers.host);
    if (hostname.endsWith(domainSuffix)) {
      const sub = hostname.slice(0, -domainSuffix.length);
      if (sub && !sub.includes('.')) return tunnelManager.getTunnelBySubdomain(sub);
      return null;
    }
    // `?tunnel=<id>` fallback (setups without wildcard DNS). Never on our own
    // names: tunnel content must not appear on the dashboard's host or on
    // another tunnel's subdomain (cookie tossing / same-origin access).
    if (hostname === domain) return null;
    const q = typeof req.url === 'string' ? req.url.indexOf('?') : -1;
    if (q >= 0) {
      let id = null;
      try { id = new URLSearchParams(req.url.slice(q + 1)).get('tunnel'); } catch {}
      if (id && isUuid(id)) {
        const t = tunnelManager.getTunnel(id.toLowerCase());
        if (t && t.protocol === 'http') return t;
      }
    }
    return null;
  }

  function openStream(tunnel, onTraffic) {
    if (tcpProxy && typeof tcpProxy.openStream === 'function') return tcpProxy.openStream(tunnel.id, { onTraffic });
    if (tunnel.status !== 'active') return null;
    return openTunnelStream(tunnel, { onTraffic });
  }

  /** X-Forwarded-* values; incoming ones are only kept from a trusted proxy. */
  function forwardingInfo(req) {
    const peer = (req.socket && req.socket.remoteAddress) || '';
    let trusted = false;
    try { trusted = !!peer && isTrustedPeer(peer, 0); } catch {}
    const clientIp = getClientIp(req) || peer || 'unknown';
    const first = (v) => String([].concat(v)[0] || '').split(',')[0].trim();
    const priorXff = req.headers['x-forwarded-for'];
    const xff = trusted && priorXff ? `${[].concat(priorXff).join(', ')}, ${peer}` : clientIp;
    let proto = req.socket && req.socket.encrypted ? 'https' : 'http';
    if (trusted && req.headers['x-forwarded-proto']) {
      const p = first(req.headers['x-forwarded-proto']).toLowerCase();
      if (p === 'http' || p === 'https') proto = p;
    }
    let host = req.headers.host || '';
    if (trusted && req.headers['x-forwarded-host']) host = first(req.headers['x-forwarded-host']) || host;
    return { trusted, clientIp, xff, proto, host };
  }

  /**
   * Headers sent to the device: hop-by-hop headers dropped (Connection and
   * Upgrade kept for upgrade requests), forwarding headers regenerated.
   */
  function requestHeaders(req, fwd, upgrade) {
    const listed = connectionTokens(req.headers.connection);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'expect') continue;
      if (HOP_BY_HOP.has(name) || listed.has(name)) continue;
      if (FORWARDING_HEADERS.has(name) && !(fwd.trusted && name === 'forwarded')) continue;
      headers[name] = value;
    }
    if (upgrade) {
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade;
    } else {
      if (/\bchunked\b/i.test(String(req.headers['transfer-encoding'] || ''))) {
        headers['transfer-encoding'] = 'chunked';
      }
      headers.connection = 'close';
    }
    headers['x-forwarded-for'] = fwd.xff;
    headers['x-forwarded-proto'] = fwd.proto;
    if (fwd.host) headers['x-forwarded-host'] = fwd.host;
    headers['x-real-ip'] = fwd.clientIp;
    return headers;
  }

  function startAccounting(tunnel, clientIp) {
    const trackId = connectionTracker ? connectionTracker.startConnection(tunnel.id, clientIp) : null;
    const onTraffic = (bytesIn, bytesOut) => {
      if (trackId) connectionTracker.updateBytes(trackId, bytesIn, bytesOut);
      tunnelManager.addBytes(tunnel.id, bytesIn + bytesOut);
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (trackId) connectionTracker.completeConnection(trackId);
    };
    return { onTraffic, finish };
  }

  function onRequest(req, res) {
    const tunnel = resolveTunnel(req);
    if (!tunnel) {
      return sendJson(res, 404, { error: 'Tunnel not found', message: 'No tunnel matches this subdomain or ID.' });
    }
    if (tunnel.status !== 'active') {
      return sendJson(res, 502, { error: 'Tunnel offline', message: 'The requested tunnel is not currently active.' });
    }

    const fwd = forwardingInfo(req);
    const acct = startAccounting(tunnel, fwd.clientIp);
    const stream = openStream(tunnel, acct.onTraffic);
    if (!stream) {
      acct.finish();
      return sendJson(res, 502, { error: 'Tunnel client disconnected' });
    }
    tunnelManager.incrementConnections(tunnel.id);

    const headers = requestHeaders(req, fwd, false);

    let timedOut = false;
    stream.setTimeout(idleTimeoutMs, () => {
      timedOut = true;
      stream.destroy();
    });

    let proxyReq;
    try {
      proxyReq = http.request({
        method: req.method,
        path: req.url,
        headers,
        // No `agent`: with an agent Node ignores createConnection.
        setHost: false,
        createConnection: () => stream,
      });
    } catch (err) {
      stream.destroy();
      acct.finish();
      return sendJson(res, 400, { error: 'Bad request', message: 'Request cannot be forwarded.' });
    }

    const cleanup = () => {
      stream.destroy();
      if (!proxyReq.destroyed) proxyReq.destroy();
      acct.finish();
    };
    res.once('close', cleanup);

    proxyReq.on('response', (proxyRes) => {
      let outHeaders;
      try {
        outHeaders = filterResponseHeaders(proxyRes.headers);
        res.writeHead(proxyRes.statusCode, proxyRes.statusMessage || undefined, outHeaders);
      } catch (err) {
        log.warn('Invalid response from tunnel client', { tunnelId: tunnel.id, error: err.message });
        proxyRes.resume();
        sendJson(res, 502, { error: 'Bad gateway', message: 'Invalid response from tunnel client.' });
        return;
      }
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
      // Device went away mid-body: abort the client response (never truncate silently).
      proxyRes.on('close', () => { if (!proxyRes.complete) res.destroy(); });
    });

    proxyReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (timedOut) {
        sendJson(res, 504, { error: 'Tunnel timeout', message: 'The tunnel client did not respond in time.' });
      } else {
        log.debug('Tunnel request failed', { tunnelId: tunnel.id, error: err.message });
        sendJson(res, 502, { error: 'Bad gateway', message: 'The tunnel client closed the connection.' });
      }
    });

    req.on('error', () => cleanup());
    req.pipe(proxyReq);
    log.debug('Forwarding request', { tunnelId: tunnel.id, method: req.method });
  }

  /**
   * WebSocket (or any Upgrade) passthrough. The handshake goes through the
   * HTTP client so the device's response headers get the same filtering as
   * normal responses; after a 101 both sides are spliced as raw streams.
   */
  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const tunnel = resolveTunnel(req);
    if (!tunnel) return rejectRaw(socket, 404, 'Not Found');
    if (tunnel.status !== 'active') return rejectRaw(socket, 502, 'Bad Gateway');

    const fwd = forwardingInfo(req);
    const acct = startAccounting(tunnel, fwd.clientIp);
    const stream = openStream(tunnel, acct.onTraffic);
    if (!stream) {
      acct.finish();
      return rejectRaw(socket, 502, 'Bad Gateway');
    }
    tunnelManager.incrementConnections(tunnel.id);

    let proxyReq;
    try {
      proxyReq = http.request({
        method: req.method,
        path: req.url,
        headers: requestHeaders(req, fwd, true),
        // No `agent`: with an agent Node ignores createConnection.
        setHost: false,
        createConnection: () => stream,
      });
    } catch (err) {
      stream.destroy();
      acct.finish();
      return rejectRaw(socket, 400, 'Bad Request');
    }

    let upgraded = false;
    // Handshake deadline (the upgraded connection itself has no idle timeout).
    stream.setTimeout(idleTimeoutMs, () => { if (!upgraded) stream.destroy(); });
    socket.once('close', () => {
      acct.finish();
      if (!upgraded) {
        proxyReq.destroy();
        stream.destroy();
      }
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      upgraded = true;
      stream.setTimeout(0);
      if (socket.destroyed) {
        proxySocket.destroy();
        return;
      }
      socket.write(serializeResponseHead(proxyRes, true));
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      spliceSocket(socket, proxySocket);
    });

    proxyReq.on('response', (proxyRes) => {
      // The application declined the upgrade: relay its response, then close.
      if (socket.destroyed) {
        proxyRes.resume();
        return;
      }
      socket.write(serializeResponseHead(proxyRes, false));
      proxyRes.pipe(socket);
      proxyRes.on('error', () => socket.destroy());
      proxyRes.on('close', () => { if (!proxyRes.complete) socket.destroy(); });
    });

    proxyReq.on('error', (err) => {
      log.debug('Tunnel upgrade failed', { tunnelId: tunnel.id, error: err.message });
      if (!upgraded && !socket.destroyed) rejectRaw(socket, 502, 'Bad Gateway');
    });

    proxyReq.end();
    log.debug('Forwarding upgrade request', { tunnelId: tunnel.id });
  }

  let server;
  const proxyCert = process.env.TLS_PROXY_CERT || process.env.TLS_CERT;
  const proxyKey = process.env.TLS_PROXY_KEY || process.env.TLS_KEY;
  if (proxyCert && proxyKey) {
    let tlsOptions;
    try {
      tlsOptions = { cert: fs.readFileSync(proxyCert), key: fs.readFileSync(proxyKey) };
    } catch (err) {
      log.fatal('Cannot read the HTTP proxy TLS certificate/key. Check TLS_PROXY_CERT/TLS_PROXY_KEY '
        + '(or TLS_CERT/TLS_KEY) and that the service user can read them.', { code: err.code, path: err.path });
      throw new Error(`Cannot read proxy TLS certificate/key: ${err.code || err.message}`);
    }
    server = https.createServer(tlsOptions, onRequest);
    log.info('Proxy TLS enabled');
  } else {
    server = http.createServer(onRequest);
  }
  // Streaming bodies: no whole-request deadline; idle timeouts live on the tunnel stream.
  server.requestTimeout = 0;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on('upgrade', onUpgrade);
  return server;
}

module.exports = { createProxyServer, stripCookieDomain, filterResponseHeaders, serializeResponseHead, hostnameOf };
