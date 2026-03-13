const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const log = createLogger('ssh-ws');

const MAX_SESSIONS = 10;
const CRED_TIMEOUT_MS = 15_000; // 15s to send credentials
const SSH_TIMEOUT_MS = 10_000;  // 10s SSH connect timeout

// Per-IP rate limiting: max 5 SSH opens per minute
const sshRateMap = new Map();
const SSH_RATE_WINDOW = 60_000;
const SSH_RATE_MAX = 5;

function checkSshRate(ip) {
  const now = Date.now();
  const entry = sshRateMap.get(ip);
  if (!entry || now - entry.windowStart > SSH_RATE_WINDOW) {
    sshRateMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= SSH_RATE_MAX;
}

// Clean up rate map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of sshRateMap) {
    if (now - entry.windowStart > SSH_RATE_WINDOW) sshRateMap.delete(ip);
  }
}, SSH_RATE_WINDOW).unref();

let activeSessions = 0;

/**
 * Attach an SSH WebSocket server to an existing HTTP(S) server.
 * Handles upgrades to /ws/ssh
 *
 * @param {http.Server} server
 * @param {TunnelManager} tunnelManager
 * @param {object} db
 * @param {string|undefined} authToken - process.env.AUTH_TOKEN
 */
function initSshWebSocket(server, tunnelManager, db, authToken) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/ssh') return; // handled by other upgrade handlers

    // Auth check
    const clientToken = url.searchParams.get('auth_token');
    if (authToken) {
      if (!clientToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const bufA = Buffer.from(authToken);
      const bufB = Buffer.from(clientToken);
      if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const tunnelId = url.searchParams.get('tunnelId');
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Validate tunnel
    const tunnel = tunnelId ? tunnelManager.getTunnel(tunnelId) : null;
    if (!tunnel) {
      send(ws, { type: 'error', message: 'Tunnel not found' });
      ws.close(1008, 'Tunnel not found');
      return;
    }
    if (tunnel.protocol !== 'tcp' || !tunnel.allocatedPort) {
      send(ws, { type: 'error', message: 'Tunnel is not a TCP tunnel or has no allocated port' });
      ws.close(1008, 'Not a TCP tunnel');
      return;
    }
    if (tunnel.status !== 'active') {
      send(ws, { type: 'error', message: 'Tunnel is not active' });
      ws.close(1008, 'Tunnel inactive');
      return;
    }

    // Rate limiting
    if (!checkSshRate(clientIp)) {
      send(ws, { type: 'error', message: 'Too many SSH connections. Try again in a minute.' });
      ws.close(1008, 'Rate limited');
      return;
    }

    // Concurrency limit
    if (activeSessions >= MAX_SESSIONS) {
      send(ws, { type: 'error', message: 'Maximum concurrent SSH sessions reached' });
      ws.close(1013, 'Max sessions');
      return;
    }

    // Send "ready for credentials" signal
    send(ws, { type: 'ready' });

    // Wait for credentials (first message only)
    const credTimeout = setTimeout(() => {
      send(ws, { type: 'error', message: 'Credentials timeout' });
      ws.close(1008, 'Timeout');
    }, CRED_TIMEOUT_MS);

    let credentialsReceived = false;
    let sshClient = null;
    let sshStream = null;

    ws.on('message', async (raw) => {
      if (!credentialsReceived) {
        clearTimeout(credTimeout);
        credentialsReceived = true;

        let creds;
        try {
          creds = JSON.parse(raw.toString());
        } catch {
          send(ws, { type: 'error', message: 'Invalid credentials message' });
          ws.close(1008, 'Invalid message');
          return;
        }

        if (creds.type !== 'credentials' || !creds.username) {
          send(ws, { type: 'error', message: 'Missing credentials' });
          ws.close(1008, 'Missing credentials');
          return;
        }

        // Build SSH connect config — never log password or private key
        const connectConfig = {
          host: '127.0.0.1',
          port: tunnel.allocatedPort,
          username: creds.username,
          readyTimeout: SSH_TIMEOUT_MS,
          keepaliveInterval: 10000,
        };

        if (creds.useStoredKey) {
          // Fetch private key from DB — never from frontend
          const tokenRow = tunnel.clientToken
            ? db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [tunnel.clientToken])
            : null;
          if (!tokenRow || !tokenRow.private_key) {
            send(ws, { type: 'error', message: 'No stored SSH key found for this tunnel' });
            ws.close(1008, 'No stored key');
            return;
          }
          connectConfig.privateKey = tokenRow.private_key;
        } else if (creds.privateKey) {
          connectConfig.privateKey = creds.privateKey;
          if (creds.passphrase) connectConfig.passphrase = creds.passphrase;
        } else if (creds.password) {
          connectConfig.password = creds.password;
        } else {
          send(ws, { type: 'error', message: 'No authentication method provided' });
          ws.close(1008, 'No auth method');
          return;
        }

        activeSessions++;
        sshClient = new Client();

        sshClient.on('ready', () => {
          log.info('SSH session established', { tunnelId, tunnelName: tunnel.name, clientIp });
          send(ws, { type: 'connected' });

          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              log.warn('SSH shell error', { tunnelId, error: err.message });
              send(ws, { type: 'error', message: `Shell error: ${err.message}` });
              ws.close(1011, 'Shell error');
              sshClient.end();
              return;
            }

            sshStream = stream;

            stream.on('data', (data) => {
              if (ws.readyState === 1) {
                send(ws, { type: 'data', data: data.toString('base64') });
              }
            });

            stream.stderr.on('data', (data) => {
              if (ws.readyState === 1) {
                send(ws, { type: 'data', data: data.toString('base64') });
              }
            });

            stream.on('close', () => {
              log.info('SSH stream closed', { tunnelId });
              if (ws.readyState === 1) {
                send(ws, { type: 'disconnected' });
                ws.close(1000, 'SSH stream closed');
              }
            });
          });
        });

        sshClient.on('error', (err) => {
          log.warn('SSH client error', { tunnelId, error: err.message });
          send(ws, { type: 'error', message: `SSH error: ${err.message}` });
          if (ws.readyState === 1) ws.close(1011, 'SSH error');
        });

        sshClient.on('end', () => {
          activeSessions = Math.max(0, activeSessions - 1);
        });

        sshClient.on('close', () => {
          activeSessions = Math.max(0, activeSessions - 1);
        });

        try {
          sshClient.connect(connectConfig);
        } catch (err) {
          log.warn('SSH connect threw', { tunnelId, error: err.message });
          send(ws, { type: 'error', message: `Connect error: ${err.message}` });
          ws.close(1011, 'Connect error');
          activeSessions = Math.max(0, activeSessions - 1);
        }

        return;
      }

      // Subsequent messages: data or resize
      if (!sshStream) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'data' && msg.data) {
        try {
          sshStream.write(Buffer.from(msg.data, 'base64'));
        } catch {}
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        try {
          sshStream.setWindow(msg.rows, msg.cols, 0, 0);
        } catch {}
      }
    });

    ws.on('close', () => {
      clearTimeout(credTimeout);
      if (sshStream) {
        try { sshStream.close(); } catch {}
      }
      if (sshClient) {
        try { sshClient.end(); } catch {}
      }
    });

    ws.on('error', (err) => {
      log.warn('SSH WebSocket error', { tunnelId, error: err.message });
    });
  });

  log.info('SSH WebSocket handler initialized on /ws/ssh');
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

module.exports = { initSshWebSocket };
