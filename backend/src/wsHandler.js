const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { notify } = require('./notifier');
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
 * @param {object} db - database module
 * @param {TcpProxy} tcpProxy
 */
function initWebSocket(server, tunnelManager, connectionTracker, db, tcpProxy) {
  const AUTH_TOKEN = process.env.AUTH_TOKEN;

  // noServer: true — we handle the upgrade event manually so that other WebSocket
  // handlers (e.g. sshWsHandler on /ws/ssh) can coexist on the same HTTP server.
  // Using { server, path } causes the ws library to send HTTP 400 + destroy the
  // socket for any non-matching path, which would block /ws/ssh entirely.
  const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_MESSAGE_SIZE });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/ws') return; // let other handlers (sshWsHandler etc.) deal with it

    // Auth check (mirrors the old verifyClient logic)
    if (AUTH_TOKEN) {
      const parsed = url.parse(req.url, true);
      const token = parsed.query.auth_token
        || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

      let clientToken = null;
      let authorized = safeTokenCompare(token, AUTH_TOKEN);

      if (!authorized && db && token) {
        try {
          const row = db.queryOne('SELECT * FROM tokens WHERE token = ? AND active = 1', [token]);
          if (row) { authorized = true; clientToken = row; }
        } catch {}
      }

      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      req._clientToken = clientToken;
    } else {
      req._clientToken = null;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    // Track ALL tunnel IDs for this WS connection (not just the last one)
    const clientTunnelIds = [];

    const clientToken = req._clientToken || null;
    ws.clientToken = clientToken;
    if (clientToken && db) {
      try { db.run("UPDATE tokens SET last_seen = datetime('now') WHERE token = ?", [clientToken.token]); } catch {}
    }

    log.info('New client connection', { ip: clientIp });

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
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

          const protocol = msg.protocol === 'tcp' ? 'tcp' : 'http';
          const name = ws.clientToken
            ? String(ws.clientToken.label || ws.clientToken.token).substring(0, 100)
            : String(msg.name || 'unnamed').substring(0, 100);
          const localPort = parseInt(msg.localPort, 10);
          if (!localPort || localPort < 1 || localPort > 65535) {
            ws.send(JSON.stringify({ type: 'error', message: 'localPort must be between 1 and 65535' }));
            break;
          }
          const config = {
            name,
            localPort,
            subdomain: protocol === 'http' && msg.subdomain
              ? String(msg.subdomain).substring(0, 63).replace(/[^a-z0-9-]/gi, '-')
              : undefined,
            protocol,
            clientToken: ws.clientToken?.token,
          };
          const tunnel = tunnelManager.createTunnel(config, ws);
          clientTunnelIds.push(tunnel.id);

          // For TCP tunnels: start TCP listener
          let allocatedPort = null;
          if (protocol === 'tcp' && tcpProxy) {
            allocatedPort = await tcpProxy.startListener(tunnel.id, ws, config.localPort, ws.clientToken, null);
            if (allocatedPort !== null) {
              tunnelManager.setAllocatedPort(tunnel.id, allocatedPort);
            }
          }

          ws.send(JSON.stringify({
            type: 'registered',
            tunnelId: tunnel.id,
            publicUrl: tunnel.publicUrl,
            ownerSecret: tunnel.ownerSecret,
            protocol,
            allocatedPort,
            localPort: config.localPort,
          }));

          notify('tunnel:connected', { tunnelName: tunnel.name, tunnelId: tunnel.id, allocatedPort });
          log.info('Tunnel registered', { name: tunnel.name, protocol, allocatedPort, tunnelId: tunnel.id });
          break;
        }

        case 'reconnect': {
          if (msg.tunnelId && msg.ownerSecret && tunnelManager.reconnect(msg.tunnelId, ws, msg.ownerSecret)) {
            if (!clientTunnelIds.includes(msg.tunnelId)) {
              clientTunnelIds.push(msg.tunnelId);
            }
            const tunnel = tunnelManager.getTunnel(msg.tunnelId);

            // Tunnel was manually paused — hold the WS in standby, don't start TCP
            if (tunnel.status === 'paused') {
              ws.send(JSON.stringify({ type: 'standby', tunnelId: msg.tunnelId }));
              log.info('Tunnel in standby (manually paused)', { tunnelId: msg.tunnelId });
              break;
            }

            // For TCP tunnels: always restart the listener so it uses the new WS.
            // The old listener may still be running with a stale WS reference if the
            // client reconnected before the old close event fired.
            let allocatedPort = tunnel.allocatedPort;
            if (tunnel.protocol === 'tcp' && tcpProxy) {
              if (tcpProxy.servers.has(msg.tunnelId)) {
                tcpProxy.stopListener(msg.tunnelId); // replace stale listener
              }
              allocatedPort = await tcpProxy.startListener(msg.tunnelId, ws, tunnel.localPort, ws.clientToken, tunnel.preferredPort || null);
              if (allocatedPort !== null) {
                tunnelManager.setAllocatedPort(msg.tunnelId, allocatedPort);
              }
            }

            ws.send(JSON.stringify({
              type: 'reconnected',
              tunnelId: msg.tunnelId,
              publicUrl: tunnel.publicUrl,
              allocatedPort,
              localPort: tunnel.localPort,
            }));
            notify('tunnel:connected', { tunnelName: tunnel.name, tunnelId: tunnel.id, allocatedPort });
            log.info('Tunnel reconnected', { tunnelId: msg.tunnelId, allocatedPort });
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

        case 'tcp-data': {
          if (tcpProxy && msg.connId && msg.data) tcpProxy.forwardData(msg.connId, msg.data);
          break;
        }

        case 'tcp-close': {
          if (tcpProxy && msg.connId) tcpProxy.closeConn(msg.connId);
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    });

    ws.on('close', () => {
      log.info('Client disconnected', { tunnelIds: clientTunnelIds, ip: clientIp });
      for (const tid of clientTunnelIds) {
        const t = tunnelManager.getTunnel(tid);
        // If the tunnel already has a NEW WS (client reconnected before this close
        // event fired), skip side-effects that belong to the old session only.
        const isStillCurrent = !t || !t.clientWs || t.clientWs === ws;
        if (t && t.status !== 'paused' && isStillCurrent) {
          notify('tunnel:disconnected', { tunnelName: t.name, tunnelId: tid });
        }
        if (t?.protocol === 'tcp' && tcpProxy && isStillCurrent) {
          tcpProxy.stopListener(tid);
        }
        tunnelManager.markDisconnected(tid, ws); // no-op if already reconnected (has guard)
        if (isStillCurrent) connectionTracker.removeByTunnel(tid);
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
