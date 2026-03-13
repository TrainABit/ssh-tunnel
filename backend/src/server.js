require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const crypto = require('crypto');
const { createLogger, requestLogger, errorHandler, setupGlobalHandlers } = require('./logger');
const log = createLogger('server');

// Set up global error handlers early
setupGlobalHandlers();

const TunnelManager = require('./tunnelManager');
const ConnectionTracker = require('./connectionTracker');
const TcpProxy = require('./tcpProxy');
const { initWebSocket } = require('./wsHandler');
const { initSshWebSocket } = require('./sshWsHandler');
const { createProxyServer } = require('./proxyServer');
const tunnelsRouter = require('./routes/tunnels');
const connectionsRouter = require('./routes/connections');
const statsRouter = require('./routes/stats');
const tokensRouter = require('./routes/tokens');
const sessionsRouter = require('./routes/sessions');
const db = require('./database');

// ─── Config ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4000;
const PROXY_PORT = parseInt(process.env.PROXY_PORT, 10) || 4001;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const startTime = Date.now();

// Warn loudly if no auth token is set
if (!AUTH_TOKEN) {
  if (process.env.NODE_ENV === 'production') {
    log.fatal('AUTH_TOKEN is not set! Refusing to start in production without authentication.');
    process.exit(1);
  }
  log.warn('AUTH_TOKEN is not set — all API endpoints are UNAUTHENTICATED (dev mode)');
}

/**
 * Constant-time token comparison to prevent timing attacks.
 */
function safeTokenCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Core services ───────────────────────────────────────
const tunnelManager = new TunnelManager(db);
const connectionTracker = new ConnectionTracker();
const tcpProxy = new TcpProxy(connectionTracker, db, tunnelManager);

// ─── Express app (API) ──────────────────────────────────
const app = express();

// Trust proxy headers when behind Nginx/reverse proxy (needed for correct req.ip)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// CORS: restrict origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : undefined; // undefined = allow all in dev; set ALLOWED_ORIGINS in production
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));

app.use(express.json({ limit: '1mb' }));

// ─── Request logging ─────────────────────────────────────
app.use(requestLogger());

// ─── Security headers ───────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:;");
  if (process.env.TLS_CERT) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
});

// ─── Simple rate limiting (BEFORE auth to prevent brute-force) ───
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 100; // requests per window

app.use('/api', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests', message: 'Rate limit exceeded. Try again later.' });
  }
  next();
});

// Clean up rate limit map periodically (store ref for shutdown)
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ─── Authentication middleware ──────────────────────────
function requireAuth(req, res, next) {
  // Skip auth if no AUTH_TOKEN is configured (development mode)
  if (!AUTH_TOKEN) {
    return next();
  }

  // Allow health check without auth
  if (req.path === '/health' || req.path === '/api/health') {
    return next();
  }

  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '')
    || req.query.auth_token;

  if (!token || !safeTokenCompare(token, AUTH_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid AUTH_TOKEN required' });
  }
  next();
}

// Apply auth to all /api routes except health
app.use('/api', requireAuth);

// API routes
app.use('/api/tunnels', tunnelsRouter(tunnelManager));
app.use('/api/connections', connectionsRouter(connectionTracker));
app.use('/api/stats', statsRouter(tunnelManager, connectionTracker, startTime, db));
app.use('/api/tokens', tokensRouter(db));
app.use('/api/sessions', sessionsRouter(db));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Date.now() - startTime });
});

// Serve static frontend files if they exist
const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(frontendPath));
app.get('/{*splat}', (req, res, next) => {
  // Only serve index.html for non-API routes
  if (req.path.startsWith('/api/') || req.path === '/ws') {
    return next();
  }
  const indexPath = path.join(frontendPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      // Frontend not built yet, that's fine
      res.status(200).json({
        message: 'TunnelVault API is running. Frontend not built yet.',
        api: {
          tunnels: '/api/tunnels',
          connections: '/api/connections',
          stats: '/api/stats',
          tokens: '/api/tokens',
          sessions: '/api/sessions',
          health: '/api/health',
        },
      });
    }
  });
});

// ─── Global error handler (must be last middleware) ─────
app.use(errorHandler());

// ─── HTTP(S) server + WebSocket ─────────────────────────
const tlsEnabled = process.env.TLS_CERT && process.env.TLS_KEY;
let server;
if (tlsEnabled) {
  const tlsOptions = {
    cert: fs.readFileSync(process.env.TLS_CERT),
    key: fs.readFileSync(process.env.TLS_KEY),
  };
  server = https.createServer(tlsOptions, app);
  log.info('TLS enabled');
} else {
  server = http.createServer(app);
}
initWebSocket(server, tunnelManager, connectionTracker, db, tcpProxy);
initSshWebSocket(server, tunnelManager, db, AUTH_TOKEN);

// ─── Proxy server ───────────────────────────────────────
const proxyServer = createProxyServer(tunnelManager, connectionTracker);

// ─── Start servers ──────────────────────────────────────
server.listen(PORT, () => {
  const proto = tlsEnabled ? 'https' : 'http';
  const wsProto = tlsEnabled ? 'wss' : 'ws';
  log.info(`API + WS server running on ${proto}://localhost:${PORT}`);
  log.info(`WebSocket endpoint: ${wsProto}://localhost:${PORT}/ws`);
});

proxyServer.listen(PROXY_PORT, () => {
  log.info(`Proxy server running on http://localhost:${PROXY_PORT}`);
});

// ─── Graceful shutdown ──────────────────────────────────
function shutdown() {
  log.info('Shutting down...');
  clearInterval(rateLimitCleanup);
  connectionTracker.destroy();
  tcpProxy.destroy();
  db.close();
  server.close(() => {
    proxyServer.close(() => {
      process.exit(0);
    });
  });
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
