const WebSocket = require('ws');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { notify } = require('./notifier');
const { createRateLimiter } = require('./rateLimiter');
const ClientRegistry = require('./clientRegistry');
const {
  WS_MAX_PAYLOAD,
  PROTOCOL_HEADER,
  CLOSE_CODES,
  ERROR_CODES,
  TUNNEL_NOT_FOUND_MESSAGE,
  TunnelChannel,
  helloMessage,
  parseProtocolHeader,
  parseClientMessage,
} = require('./protocol');
const log = createLogger('ws');

const DEFAULT_MAX_TUNNELS_PER_TOKEN = 10;
const DEFAULT_MAX_CONNECTIONS_PER_TOKEN = 4;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_UPGRADE_ATTEMPTS_PER_MIN = 60;
const DEFAULT_AUTH_FAILURES_PER_MIN = 10;
const MAX_VIOLATIONS = 50;           // invalid messages before closing with 4001
const MAX_TOKEN_LENGTH = 512;

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Constant-time token comparison (hash first so lengths do not leak). */
function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tokenPrefix(token) {
  return typeof token === 'string' && token ? `${token.slice(0, 4)}***` : 'admin';
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

function rejectUpgrade(socket, status, text, extraHeaders = '') {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${extraHeaders}\r\n`);
  } catch {}
  socket.destroy();
}

/**
 * Attach the device WebSocket endpoint (/ws) to an HTTP(S) server.
 *
 *   initWebSocket(server, { tunnelManager, connectionTracker, db, tcpProxy, registry,
 *                           getClientIp, authToken, heartbeatMs? })
 *     -> { wss, registry, close() }
 *
 * Optional deps (mainly for tests): heartbeatMs, maxConnectionsPerToken,
 * maxTunnelsPerToken, upgradeAttemptsPerMin, authFailuresPerMin.
 * The legacy positional signature (server, tunnelManager, connectionTracker,
 * db, tcpProxy) is still accepted.
 */
function initWebSocket(server, deps = {}, ...legacyArgs) {
  if (deps && typeof deps.getTunnel === 'function') {
    const [connectionTracker, db, tcpProxy] = legacyArgs;
    deps = { tunnelManager: deps, connectionTracker, db, tcpProxy };
  }
  const {
    tunnelManager,
    connectionTracker = null,
    db = null,
    tcpProxy = null,
  } = deps;
  if (!tunnelManager) throw new TypeError('initWebSocket requires deps.tunnelManager');
  const registry = deps.registry || new ClientRegistry();
  const getClientIp = typeof deps.getClientIp === 'function'
    ? deps.getClientIp
    : (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
  const AUTH_TOKEN = deps.authToken !== undefined ? deps.authToken : process.env.AUTH_TOKEN;
  const heartbeatMs = deps.heartbeatMs > 0 ? deps.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const maxConnectionsPerToken = deps.maxConnectionsPerToken > 0
    ? deps.maxConnectionsPerToken : envInt('MAX_CONNECTIONS_PER_TOKEN', DEFAULT_MAX_CONNECTIONS_PER_TOKEN);
  const maxTunnelsPerToken = deps.maxTunnelsPerToken > 0
    ? deps.maxTunnelsPerToken : envInt('MAX_TUNNELS_PER_TOKEN', DEFAULT_MAX_TUNNELS_PER_TOKEN);
  const attemptLimiter = createRateLimiter({
    windowMs: 60_000,
    max: deps.upgradeAttemptsPerMin > 0 ? deps.upgradeAttemptsPerMin : envInt('WS_UPGRADE_RATE_MAX', DEFAULT_UPGRADE_ATTEMPTS_PER_MIN),
  });
  const failureLimiter = createRateLimiter({
    windowMs: 60_000,
    max: deps.authFailuresPerMin > 0 ? deps.authFailuresPerMin : envInt('WS_AUTH_FAIL_MAX', DEFAULT_AUTH_FAILURES_PER_MIN),
  });

  // noServer: true — we handle the upgrade event manually so that other WebSocket
  // handlers (e.g. sshWsHandler on /ws/ssh) can coexist on the same HTTP server.
  const wss = new WebSocket.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });
  const upgradeContext = new WeakMap(); // req -> { clientToken, protocolVersion, ip }

  function lookupDeviceToken(token) {
    if (!db || !token || token.length > MAX_TOKEN_LENGTH) return null;
    try {
      return db.queryOne('SELECT id, token, label, active FROM tokens WHERE token = ? AND active = 1', [token]) || null;
    } catch (err) {
      log.error('Token lookup failed', { error: err.message });
      return null;
    }
  }

  function onUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname !== '/ws') return; // let other handlers (sshWsHandler etc.) deal with it

    const ip = getClientIp(req) || 'unknown';
    if (failureLimiter.isLimited(ip) || !attemptLimiter.hit(ip)) {
      log.warn('WebSocket upgrade rate limited', { ip });
      rejectUpgrade(socket, 429, 'Too Many Requests', 'Retry-After: 60\r\n');
      return;
    }

    // Authorization: Bearer only (query-string tokens are not accepted).
    const token = bearerToken(req);
    let clientToken = null;
    let authorized = false;
    if (token) {
      if (AUTH_TOKEN && safeTokenCompare(token, AUTH_TOKEN)) {
        authorized = true;
      } else {
        clientToken = lookupDeviceToken(token);
        authorized = !!clientToken;
      }
    }
    if (!authorized && !AUTH_TOKEN) authorized = true; // dev mode: unauthenticated admin

    if (!authorized) {
      failureLimiter.hit(ip);
      log.warn('WebSocket upgrade unauthorized', { ip });
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    upgradeContext.set(req, {
      clientToken,
      protocolVersion: parseProtocolHeader(req.headers[PROTOCOL_HEADER]),
      ip,
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  server.on('upgrade', onUpgrade);

  function sendJson(ws, msg) {
    if (ws.tunnelChannel) return ws.tunnelChannel.sendControl(msg);
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sendError(ws, code, message, extra = {}) {
    sendJson(ws, { type: 'error', message, ...(code ? { code } : {}), ...extra });
  }

  function liveTunnelsOnWs(ws) {
    let n = 0;
    for (const id of ws.tunnelIds) {
      const t = tunnelManager.getTunnel(id);
      if (t && t.clientWs === ws) n++;
    }
    return n;
  }

  /** Would attaching one more tunnel exceed the owner's limit? */
  function overTunnelLimit(ws, reconnectingId = null) {
    const token = ClientRegistry.tokenOf(ws);
    if (token) {
      return tunnelManager.countLiveTunnelsForToken(token, reconnectingId) >= maxTunnelsPerToken;
    }
    if (reconnectingId) {
      const t = tunnelManager.getTunnel(reconnectingId);
      if (t && t.clientWs === ws) return false;
    }
    return liveTunnelsOnWs(ws) >= maxTunnelsPerToken;
  }

  function enforceConnectionCap(ws) {
    const token = ClientRegistry.tokenOf(ws);
    if (!token) return; // admin-token connections are not capped per token
    const conns = registry.connectionsForToken(token);
    const excess = conns.length - maxConnectionsPerToken;
    for (let i = 0; i < excess; i++) {
      const old = conns[i];
      if (old === ws) continue;
      registry.remove(old);
      log.warn('Closing oldest connection for token (connection limit reached)', {
        token: tokenPrefix(token), limit: maxConnectionsPerToken,
      });
      registry.closeConnection(old, CLOSE_CODES.SUPERSEDED, 'Superseded by a newer connection');
    }
  }

  async function handleRegister(ws, msg) {
    if (overTunnelLimit(ws)) {
      sendError(ws, ERROR_CODES.TUNNEL_LIMIT, `Max tunnel limit (${maxTunnelsPerToken}) reached`, { localPort: msg.localPort });
      return;
    }

    const protocol = msg.protocol;
    const tokenRow = ws.clientToken;
    const name = (tokenRow && tokenRow.label) || msg.name || 'unnamed';
    const tunnel = tunnelManager.createTunnel({
      name: String(name).substring(0, 100),
      localPort: msg.localPort,
      subdomain: protocol === 'http' ? msg.subdomain : undefined,
      protocol,
      clientToken: tokenRow ? tokenRow.token : null,
      clientId: ws.clientId,
    }, ws);
    ws.tunnelIds.add(tunnel.id);

    const paused = tunnel.status === 'paused';
    let allocatedPort = null;
    if (protocol === 'tcp' && tcpProxy && !paused) {
      allocatedPort = await tcpProxy.startListener(tunnel.id, ws, msg.localPort, tokenRow, tunnel.preferredPort || null);
      if (allocatedPort !== null) {
        tunnelManager.setAllocatedPort(tunnel.id, allocatedPort);
      } else if (ws.readyState === WebSocket.OPEN) {
        log.error('Could not start TCP listener', { tunnelId: tunnel.id });
      }
    } else if (paused) {
      allocatedPort = tunnel.preferredPort || null;
    }

    sendJson(ws, {
      type: 'registered',
      tunnelId: tunnel.id,
      publicUrl: tunnel.publicUrl,
      ownerSecret: tunnel.ownerSecret,
      protocol,
      allocatedPort,
      localPort: msg.localPort,
    });
    if (paused) {
      sendJson(ws, { type: 'standby', tunnelId: tunnel.id });
      log.info('Tunnel registered in standby (manually paused)', { tunnelId: tunnel.id });
      return;
    }
    if (protocol === 'tcp' && allocatedPort === null) {
      sendError(ws, null, 'No public TCP port available for this tunnel', { tunnelId: tunnel.id, localPort: msg.localPort });
    }
    notify('tunnel:connected', { tunnelName: tunnel.name, tunnelId: tunnel.id, allocatedPort });
    log.info('Tunnel registered', { name: tunnel.name, protocol, allocatedPort, tunnelId: tunnel.id });
  }

  async function handleReconnect(ws, msg) {
    const { tunnelId } = msg;
    const notFound = () => sendError(ws, ERROR_CODES.TUNNEL_NOT_FOUND, TUNNEL_NOT_FOUND_MESSAGE, { tunnelId });
    // Ownership first (ownerSecret + same token), so the limit is only revealed to the owner.
    if (!tunnelManager.verifyReconnect(tunnelId, ws, msg.ownerSecret).ok) {
      notFound();
      return;
    }
    if (overTunnelLimit(ws, tunnelId)) {
      sendError(ws, ERROR_CODES.TUNNEL_LIMIT, `Max tunnel limit (${maxTunnelsPerToken}) reached`, { tunnelId });
      return;
    }
    if (!tunnelManager.reconnect(tunnelId, ws, msg.ownerSecret)) {
      notFound();
      return;
    }
    ws.tunnelIds.add(tunnelId);
    const tunnel = tunnelManager.getTunnel(tunnelId);

    // Tunnel was manually paused — hold the WS in standby, don't start TCP
    if (tunnel.status === 'paused') {
      if (tcpProxy) tcpProxy.stopListener(tunnelId);
      sendJson(ws, { type: 'standby', tunnelId });
      log.info('Tunnel in standby (manually paused)', { tunnelId });
      return;
    }

    // For TCP tunnels: always restart the listener so it uses the new WS (the
    // old one may still be bound to a stale connection). Keeps the same port.
    let allocatedPort = tunnel.allocatedPort;
    if (tunnel.protocol === 'tcp' && tcpProxy) {
      allocatedPort = await tcpProxy.startListener(tunnelId, ws, tunnel.localPort, ws.clientToken,
        tunnel.preferredPort || tunnel.allocatedPort || null);
      if (allocatedPort !== null) tunnelManager.setAllocatedPort(tunnelId, allocatedPort);
    }

    sendJson(ws, {
      type: 'reconnected',
      tunnelId,
      publicUrl: tunnel.publicUrl,
      allocatedPort,
      localPort: tunnel.localPort,
      protocol: tunnel.protocol,
    });
    if (tunnel.protocol === 'tcp' && tcpProxy && allocatedPort === null) {
      sendError(ws, null, 'No public TCP port available for this tunnel', { tunnelId, localPort: tunnel.localPort });
    }
    notify('tunnel:connected', { tunnelName: tunnel.name, tunnelId: tunnel.id, allocatedPort });
    log.info('Tunnel reconnected', { tunnelId, allocatedPort });
  }

  function violation(ws, code, message, extra) {
    ws.violations++;
    sendError(ws, code, message, extra);
    if (ws.violations > MAX_VIOLATIONS) {
      log.warn('Closing device connection: too many invalid messages', { ip: ws.clientIp });
      registry.remove(ws);
      registry.closeConnection(ws, CLOSE_CODES.PROTOCOL_VIOLATION, 'Protocol violation');
    }
  }

  function onMessage(ws, data, isBinary) {
    ws.isAlive = true;
    if (ws._tvClosing) return; // revoked / superseded: ignore everything
    const channel = ws.tunnelChannel;

    if (isBinary) {
      // Binary frames are data frames only; never JSON-parsed.
      channel.handleBinary(Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data)));
      return;
    }

    const parsed = parseClientMessage(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    if (!parsed.ok) {
      const { code, message, ...extra } = parsed.error;
      if (code === ERROR_CODES.TUNNEL_NOT_FOUND) {
        sendError(ws, code, message, extra); // malformed secret: re-register, not a violation
      } else {
        violation(ws, code, message, extra);
      }
      return;
    }
    const msg = parsed.msg;

    switch (msg.type) {
      case 'register':
        handleRegister(ws, msg).catch((err) => {
          log.error('Register failed', { error: err });
          sendError(ws, null, 'Registration failed', { localPort: msg.localPort });
        });
        break;
      case 'reconnect':
        handleReconnect(ws, msg).catch((err) => {
          log.error('Reconnect failed', { error: err, tunnelId: msg.tunnelId });
          sendError(ws, ERROR_CODES.TUNNEL_NOT_FOUND, TUNNEL_NOT_FOUND_MESSAGE, { tunnelId: msg.tunnelId });
        });
        break;
      case 'tcp-data':
      case 'tcp-close':
      case 'tcp-pause':
      case 'tcp-resume':
        channel.handleControl(msg);
        break;
      case 'response':
        break; // legacy reply to a `request` this server never sends
      default:
        violation(ws, ERROR_CODES.UNKNOWN_TYPE, 'Unknown message type');
    }
  }

  function onClose(ws) {
    registry.remove(ws);
    if (ws.tunnelChannel) ws.tunnelChannel.close();
    log.info('Client disconnected', { tunnelIds: [...ws.tunnelIds], ip: ws.clientIp, code: ws._tvCloseCode });
    for (const tid of ws.tunnelIds) {
      const t = tunnelManager.getTunnel(tid);
      // If the tunnel already has a NEW WS (client reconnected before this close
      // event fired), skip side-effects that belong to the old session only.
      const isStillCurrent = !t || !t.clientWs || t.clientWs === ws;
      // Only stops a listener that was started for this connection.
      if (tcpProxy) tcpProxy.stopListener(tid, ws);
      if (!isStillCurrent) continue;
      if (t && t.status !== 'paused') {
        notify('tunnel:disconnected', { tunnelName: t.name, tunnelId: tid });
      }
      if (t) tunnelManager.markDisconnected(tid, ws);
      if (connectionTracker) connectionTracker.removeByTunnel(tid);
    }
  }

  wss.on('connection', (ws, req) => {
    const ctx = upgradeContext.get(req) || { clientToken: null, protocolVersion: 1, ip: 'unknown' };
    upgradeContext.delete(req);
    const v2 = ctx.protocolVersion >= 2;

    ws.clientId = crypto.randomUUID();
    ws.clientToken = ctx.clientToken;
    ws.clientIp = ctx.ip;
    ws.protocolVersion = v2 ? 2 : 1;
    ws.tunnelIds = new Set();
    ws.violations = 0;
    ws.isAlive = true;
    ws.tunnelChannel = new TunnelChannel(ws, {
      binary: v2,
      flowControl: v2,
      onViolation: (reason) => violation(ws, ERROR_CODES.INVALID_MESSAGE, reason),
    });

    registry.add(ws);
    enforceConnectionCap(ws);

    if (ws.clientToken && db) {
      try { db.run("UPDATE tokens SET last_seen = datetime('now') WHERE token = ?", [ws.clientToken.token]); } catch {}
    }

    log.info('New client connection', {
      ip: ws.clientIp, protocol: ws.protocolVersion, token: tokenPrefix(ws.clientToken && ws.clientToken.token),
    });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(ws, data, isBinary);
      } catch (err) {
        log.error('Error handling device message', { error: err });
      }
    });
    ws.on('close', () => {
      try {
        onClose(ws);
      } catch (err) {
        log.error('Error cleaning up device connection', { error: err });
      }
    });
    ws.on('error', (err) => {
      log.warn('WebSocket error', { error: err.message, tunnelIds: [...ws.tunnelIds], ip: ws.clientIp });
    });

    sendJson(ws, helloMessage());
  });

  /** Ping every client; re-validate device tokens (revoked/deleted -> close 4000). */
  function heartbeatTick() {
    const tokenState = new Map(); // token -> still active?
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}

      const token = ClientRegistry.tokenOf(ws);
      if (!token || !db || ws._tvClosing) continue;
      if (!tokenState.has(token)) {
        let active = true;
        try {
          const row = db.queryOne('SELECT active FROM tokens WHERE token = ?', [token]);
          active = !!row && Number(row.active) === 1;
        } catch (err) {
          log.warn('Token re-validation failed', { error: err.message });
        }
        tokenState.set(token, active);
      }
      if (!tokenState.get(token)) {
        log.warn('Closing connection of revoked token', { token: tokenPrefix(token) });
        registry.remove(ws);
        registry.closeConnection(ws, CLOSE_CODES.TOKEN_REVOKED, 'Token revoked');
      }
    }
  }
  const heartbeat = setInterval(heartbeatTick, heartbeatMs);
  heartbeat.unref();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    server.removeListener('upgrade', onUpgrade);
    attemptLimiter.destroy();
    failureLimiter.destroy();
    for (const ws of wss.clients) {
      try { ws.close(1001, 'Server shutting down'); } catch {}
      const t = setTimeout(() => { try { ws.terminate(); } catch {} }, 1000);
      t.unref();
    }
    wss.close();
  }
  wss.on('close', () => clearInterval(heartbeat));

  return { wss, registry, close };
}

module.exports = { initWebSocket, safeTokenCompare };
