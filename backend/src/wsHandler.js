const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const log = createLogger('ws');

const MAX_TUNNELS_PER_CLIENT = 10;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

/**
 * Constant-time token comparison.
 */
function safeTokenCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Initialize WebSocket server for tunnel client connections.
 * @param {http.Server} server - The HTTP server to attach to
 * @param {TunnelManager} tunnelManager
 * @param {ConnectionTracker} connectionTracker
 */
function initWebSocket(server, tunnelManager, connectionTracker) {
  const AUTH_TOKEN = process.env.AUTH_TOKEN;

  const wss = new WebSocket.Server({
    server,
    path: '/ws',
    maxPayload: MAX_MESSAGE_SIZE,
    verifyClient: (info, cb) => {
      // Skip auth if no AUTH_TOKEN is configured (development mode)
      if (!AUTH_TOKEN) {
        return cb(true);
      }

      const parsed = url.parse(info.req.url, true);
      const token = parsed.query.auth_token
        || (info.req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

      if (safeTokenCompare(token, AUTH_TOKEN)) {
        return cb(true);
      }

      cb(false, 401, 'Unauthorized');
    },
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    // Track ALL tunnel IDs for this WS connection (not just the last one)
    const clientTunnelIds = [];

    log.info('New client connection', { ip: clientIp });

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      switch (msg.type) {
        case 'register': {
          if (clientTunnelIds.length >= MAX_TUNNELS_PER_CLIENT) {
            ws.send(JSON.stringify({ type: 'error', message: `Max tunnel limit (${MAX_TUNNELS_PER_CLIENT}) reached` }));
            break;
          }

          const config = {
            name: String(msg.name || 'unnamed').substring(0, 100),
            localPort: parseInt(msg.localPort, 10) || 3000,
            subdomain: msg.subdomain ? String(msg.subdomain).substring(0, 63).replace(/[^a-z0-9-]/gi, '-') : undefined,
          };
          const tunnel = tunnelManager.createTunnel(config, ws);
          clientTunnelIds.push(tunnel.id);

          ws.send(JSON.stringify({
            type: 'registered',
            tunnelId: tunnel.id,
            publicUrl: tunnel.publicUrl,
            ownerSecret: tunnel.ownerSecret,
          }));

          log.info('Tunnel registered', { name: tunnel.name, publicUrl: tunnel.publicUrl, tunnelId: tunnel.id });
          break;
        }

        case 'reconnect': {
          if (msg.tunnelId && msg.ownerSecret && tunnelManager.reconnect(msg.tunnelId, ws, msg.ownerSecret)) {
            if (!clientTunnelIds.includes(msg.tunnelId)) {
              clientTunnelIds.push(msg.tunnelId);
            }
            const tunnel = tunnelManager.getTunnel(msg.tunnelId);
            ws.send(JSON.stringify({
              type: 'reconnected',
              tunnelId: msg.tunnelId,
              publicUrl: tunnel.publicUrl,
            }));
            log.info('Tunnel reconnected', { tunnelId: msg.tunnelId });
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Tunnel not found for reconnect' }));
          }
          break;
        }

        case 'response': {
          // Proxy response from the tunnel client — handled via pending request map
          ws.emit('tunnel-response', msg);
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    });

    ws.on('close', () => {
      log.info('Client disconnected', { tunnelIds: clientTunnelIds, ip: clientIp });
      // Mark ALL tunnels for this WS as disconnected, but only if
      // the tunnel's current WS is still this one (prevents race with reconnect)
      for (const tid of clientTunnelIds) {
        tunnelManager.markDisconnected(tid, ws);
        connectionTracker.removeByTunnel(tid);
      }
    });

    ws.on('error', (err) => {
      log.error('WebSocket error', { error: err, tunnelIds: clientTunnelIds, ip: clientIp });
    });
  });

  // Heartbeat interval — ping every 30 seconds
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}

module.exports = { initWebSocket };
