'use strict';

/**
 * Test harness for the tunnel core (CORE work package).
 *
 * MUST be required before anything that loads src/database.js: it points
 * DB_PATH at a fresh temp file. Every `node --test` file runs in its own
 * process, so each test file gets its own database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-core-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'tunnelvault.db');
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'fatal';
delete process.env.WEBHOOK_URL;
delete process.env.HTTP_TUNNEL_URL_TEMPLATE;
delete process.env.TCP_BIND_HOST;

const db = require('../../src/database');
const TunnelManager = require('../../src/tunnelManager');
const ConnectionTracker = require('../../src/connectionTracker');
const TcpProxy = require('../../src/tcpProxy');
const ClientRegistry = require('../../src/clientRegistry');
const { initWebSocket } = require('../../src/wsHandler');
const { createProxyServer } = require('../../src/proxyServer');

let tokenCounter = 0;

/** Insert an active device token; returns the token string. */
function createToken(label = 'device') {
  tokenCounter++;
  const token = crypto.randomBytes(12).toString('hex');
  db.run('INSERT INTO tokens (token, label, linux_user, active) VALUES (?, ?, ?, 1)',
    [token, label, `gw-test-${process.pid}-${tokenCounter}`]);
  return token;
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Boot the core stack on ephemeral ports.
 * @param {object} [opts] - authToken, heartbeatMs, maxConnectionsPerToken, maxTunnelsPerToken,
 *   upgradeAttemptsPerMin, authFailuresPerMin, proxy (bool), domain, idleTimeoutMs, statsFlushMs
 */
async function startHarness(opts = {}) {
  const authToken = opts.authToken === undefined ? 'admin-secret-token' : opts.authToken;
  const tunnelManager = new TunnelManager(db, { statsFlushMs: opts.statsFlushMs });
  const connectionTracker = new ConnectionTracker();
  // Random 200-port window per harness so parallel test files rarely collide.
  const portMin = 20000 + Math.floor(Math.random() * 150) * 200;
  const tcpProxy = new TcpProxy(connectionTracker, db, tunnelManager, {
    portMin, portMax: portMin + 199, bindHost: '127.0.0.1',
  });
  const registry = new ClientRegistry();
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const wsApi = initWebSocket(server, {
    tunnelManager,
    connectionTracker,
    db,
    tcpProxy,
    registry,
    authToken,
    getClientIp: (req) => req.socket.remoteAddress,
    heartbeatMs: opts.heartbeatMs,
    maxConnectionsPerToken: opts.maxConnectionsPerToken,
    maxTunnelsPerToken: opts.maxTunnelsPerToken,
    upgradeAttemptsPerMin: opts.upgradeAttemptsPerMin || 10_000,
    authFailuresPerMin: opts.authFailuresPerMin || 10_000,
  });
  const port = await listen(server);

  let proxyServer = null;
  let proxyPort = null;
  if (opts.proxy) {
    proxyServer = createProxyServer(tunnelManager, connectionTracker, {
      tcpProxy,
      domain: opts.domain || 'test.local',
      trustProxy: opts.trustProxy === undefined ? false : opts.trustProxy,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    proxyPort = await listen(proxyServer);
  }

  const harness = {
    db,
    tunnelManager,
    connectionTracker,
    tcpProxy,
    registry,
    server,
    wsApi,
    port,
    proxyServer,
    proxyPort,
    authToken,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    createToken,
    async close() {
      wsApi.close();
      tcpProxy.destroy();
      tunnelManager.destroy();
      connectionTracker.destroy();
      await closeServer(proxyServer);
      await closeServer(server);
    },
  };
  return harness;
}

/** Poll until fn() is truthy (or throw after timeoutMs). */
async function waitUntil(fn, timeoutMs = 5000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

module.exports = { startHarness, createToken, listen, closeServer, waitUntil, db, TMP_DIR };
