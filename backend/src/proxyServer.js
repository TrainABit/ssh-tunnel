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
 * the `?tunnel=<id>` query parameter.
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
      if (sub && !sub.includes('.')) {
        const t = tunnelManager.getTunnelBySubdomain(sub);
        if (t) return t;
      }
    }
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

  function startAccounting(tunnel, clientIp) {
    const trackId = connectionTracker ? connectionTracker.startConnection(tunnel.id, clientIp) : null;
    tunnelManager.incrementConnections(tunnel.id);
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

    // Request headers: drop hop-by-hop, regenerate forwarding headers.
    const listed = connectionTokens(req.headers.connection);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name) || listed.has(name) || name === 'expect') continue;
      if (FORWARDING_HEADERS.has(name) && !(fwd.trusted && name === 'forwarded')) continue;
      headers[name] = value;
    }
    if (/\bchunked\b/i.test(String(req.headers['transfer-encoding'] || ''))) {
      headers['transfer-encoding'] = 'chunked';
    }
    headers.connection = 'close';
    headers['x-forwarded-for'] = fwd.xff;
    headers['x-forwarded-proto'] = fwd.proto;
    if (fwd.host) headers['x-forwarded-host'] = fwd.host;
    headers['x-real-ip'] = fwd.clientIp;

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
        agent: false,
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

  /** WebSocket (or any Upgrade) passthrough: replay the request head, then a raw pipe. */
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

    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const lower = raw[i].toLowerCase();
      if (FORWARDING_HEADERS.has(lower) && !(fwd.trusted && lower === 'forwarded')) continue;
      if (lower === 'proxy-authorization' || lower === 'proxy-connection' || lower === 'keep-alive') continue;
      lines.push(`${raw[i]}: ${raw[i + 1]}`);
    }
    lines.push(`X-Forwarded-For: ${fwd.xff}`);
    lines.push(`X-Forwarded-Proto: ${fwd.proto}`);
    if (fwd.host) lines.push(`X-Forwarded-Host: ${fwd.host}`);
    lines.push(`X-Real-IP: ${fwd.clientIp}`);

    stream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) stream.write(head);

    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.once('close', acct.finish);
    spliceSocket(socket, stream);
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

module.exports = { createProxyServer, stripCookieDomain, filterResponseHeaders, hostnameOf };
