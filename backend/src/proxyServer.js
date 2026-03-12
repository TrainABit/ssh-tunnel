const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const log = createLogger('proxy');

/**
 * Create the proxy server that receives inbound HTTP requests
 * destined for tunnel subdomains and forwards them through WebSocket.
 *
 * @param {TunnelManager} tunnelManager
 * @param {ConnectionTracker} connectionTracker
 * @returns {http.Server}
 */
function createProxyServer(tunnelManager, connectionTracker) {
  const app = express();

  // Parse body as raw buffer so we can forward it
  app.use(express.raw({ type: '*/*', limit: '10mb' }));

  app.use((req, res) => {
    // Determine which tunnel this request is for
    let tunnel = null;

    // Method 1: subdomain from Host header  (e.g. myapp.tunnel.local:4001)
    const host = req.headers.host || '';
    const hostParts = host.split('.');
    if (hostParts.length >= 2) {
      const subdomain = hostParts[0];
      tunnel = tunnelManager.getTunnelBySubdomain(subdomain);
    }

    // Method 2: query param ?tunnel=<id>
    if (!tunnel && req.query.tunnel) {
      tunnel = tunnelManager.getTunnel(req.query.tunnel);
    }

    if (!tunnel) {
      return res.status(404).json({
        error: 'Tunnel not found',
        message: 'No tunnel matches this subdomain or ID.',
      });
    }

    if (tunnel.status !== 'active') {
      return res.status(502).json({
        error: 'Tunnel offline',
        message: 'The requested tunnel is not currently active.',
      });
    }

    const ws = tunnel.clientWs;
    if (!ws || ws.readyState !== 1) {
      return res.status(502).json({
        error: 'Tunnel client disconnected',
      });
    }

    const requestId = uuidv4();
    const connId = connectionTracker.startConnection(tunnel.id, req.ip);

    // Track incoming bytes
    const bodyBuf = req.body || Buffer.alloc(0);
    const bytesIn = Buffer.isBuffer(bodyBuf) ? bodyBuf.length : Buffer.byteLength(String(bodyBuf));
    connectionTracker.updateBytes(connId, bytesIn, 0);

    // Build the forwarding message
    const forwardMsg = {
      type: 'request',
      id: requestId,
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      body: Buffer.isBuffer(bodyBuf) ? bodyBuf.toString('base64') : null,
    };

    log.debug('Forwarding request', { requestId, tunnelId: tunnel.id, method: req.method, path: req.originalUrl, bytesIn });

    // Set up response listener with timeout
    const TIMEOUT_MS = 30_000;
    let responded = false;

    const onResponse = (msg) => {
      if (msg.id !== requestId) return;
      responded = true;
      ws.removeListener('tunnel-response', onResponse);
      clearTimeout(timer);

      const statusCode = msg.statusCode || 200;
      const headers = msg.headers || {};
      let body = msg.body || '';

      // Decode base64 body if present
      let bodyBuf;
      if (msg.bodyEncoding === 'base64') {
        bodyBuf = Buffer.from(body, 'base64');
      } else {
        bodyBuf = Buffer.from(body);
      }

      // Track outgoing bytes
      connectionTracker.updateBytes(connId, 0, bodyBuf.length);
      tunnelManager.incrementConnections(tunnel.id);
      tunnelManager.addBytes(tunnel.id, bytesIn + bodyBuf.length);
      connectionTracker.completeConnection(connId);

      // Send response — only forward safe headers from tunnel client
      const BLOCKED_HEADERS = new Set([
        'transfer-encoding',
        'set-cookie',
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-allow-headers',
        'access-control-allow-methods',
        'strict-transport-security',
        'public-key-pins',
        'x-frame-options',
      ]);
      try {
        res.status(statusCode);
        for (const [key, val] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          // Block security-sensitive and CORS headers from tunnel clients
          if (!BLOCKED_HEADERS.has(lower)) {
            // Prevent header injection: reject values with newlines
            const strVal = String(val);
            if (!strVal.includes('\r') && !strVal.includes('\n')) {
              res.setHeader(key, strVal);
            }
          }
        }
        res.send(bodyBuf);
      } catch (err) {
        log.error('Error sending response', { error: err, requestId, tunnelId: tunnel.id });
      }
    };

    ws.on('tunnel-response', onResponse);

    const timer = setTimeout(() => {
      if (!responded) {
        ws.removeListener('tunnel-response', onResponse);
        connectionTracker.completeConnection(connId);
        res.status(504).json({ error: 'Tunnel timeout', message: 'Client did not respond within 30 seconds.' });
      }
    }, TIMEOUT_MS);

    // Send the request to the tunnel client
    try {
      ws.send(JSON.stringify(forwardMsg));
    } catch (err) {
      clearTimeout(timer);
      ws.removeListener('tunnel-response', onResponse);
      connectionTracker.completeConnection(connId);
      res.status(502).json({ error: 'Failed to forward request', message: err.message });
    }
  });

  let server;
  const proxyCert = process.env.TLS_PROXY_CERT || process.env.TLS_CERT;
  const proxyKey = process.env.TLS_PROXY_KEY || process.env.TLS_KEY;
  if (proxyCert && proxyKey) {
    const tlsOptions = {
      cert: fs.readFileSync(proxyCert),
      key: fs.readFileSync(proxyKey),
    };
    server = https.createServer(tlsOptions, app);
    log.info('Proxy TLS enabled');
  } else {
    server = http.createServer(app);
  }
  return server;
}

module.exports = { createProxyServer };
