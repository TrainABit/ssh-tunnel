'use strict';

/**
 * TunnelVault server factory.
 *
 *   const { createTunnelVault } = require('./app');
 *   const vault = createTunnelVault({ port: 0, proxyPort: 0 });
 *   const { port, proxyPort } = await vault.start();
 *   ...
 *   await vault.stop();
 *
 * Everything is configured from the environment (see backend/.env.example);
 * `options` override individual settings (mainly for tests). The database
 * module is chosen by DB_PATH at require time.
 */
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { createLogger, requestLogger, errorHandler } = require('./logger');
const { parseTrustProxy, createIpResolver } = require('./requestIp');
const { createRateLimiter } = require('./rateLimiter');
const { createAuth } = require('./auth');
const { loadSecretBoxFromEnv, migrateStoredKeys, SecretBoxConfigError } = require('./secretBox');
const { createMaintenance, nonNegativeInt } = require('./maintenance');
const { initGeoip, getGeoipProvider } = require('./geoip');
const TunnelManager = require('./tunnelManager');
const ConnectionTracker = require('./connectionTracker');
const TcpProxy = require('./tcpProxy');
const ClientRegistry = require('./clientRegistry');
const { initWebSocket } = require('./wsHandler');
const { initSshWebSocket } = require('./sshWsHandler');
const { createProxyServer } = require('./proxyServer');
const tunnelsRouter = require('./routes/tunnels');
const connectionsRouter = require('./routes/connections');
const statsRouter = require('./routes/stats');
const tokensRouter = require('./routes/tokens');
const sessionsRouter = require('./routes/sessions');
const authRouter = require('./routes/auth');
const configRouter = require('./routes/config');

const log = createLogger('server');

const DEFAULT_PORT = 4000;
const DEFAULT_PROXY_PORT = 4001;
const DEFAULT_API_RATE_LIMIT = 300; // requests per minute per client IP
const SHUTDOWN_GRACE_MS = 3000;
const DEFAULT_UPDATE_CONF = '/etc/tunnelvault/update.conf';

/** Configuration problem the operator must fix (server.js exits with code 78, no restart loop). */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG';
  }
}

function parsePort(value, name, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`${name} must be a port number (0-65535), got "${value}"`);
  return n;
}

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeDomain(value) {
  if (typeof TunnelManager.normalizeDomain === 'function') return TunnelManager.normalizeDomain(value);
  return String(value || 'tunnel.local').trim().toLowerCase().replace(/^\*?\.+/, '').replace(/\.+$/, '');
}

/** Effective configuration from env + overrides. */
function loadConfig(env = process.env, options = {}) {
  const pick = (key, envKey) => (options[key] !== undefined ? options[key] : env[envKey]);
  const nodeEnv = options.nodeEnv || env.NODE_ENV || 'development';
  const authToken = String(pick('authToken', 'AUTH_TOKEN') || '').trim();
  const trustProxy = options.trustProxy !== undefined ? options.trustProxy : parseTrustProxy(env);
  return {
    nodeEnv,
    authToken,
    port: parsePort(pick('port', 'PORT'), 'PORT', DEFAULT_PORT),
    proxyPort: parsePort(pick('proxyPort', 'PROXY_PORT'), 'PROXY_PORT', DEFAULT_PROXY_PORT),
    bindHost: String(pick('bindHost', 'BIND_HOST') || '').trim() || '0.0.0.0',
    trustProxy,
    domain: normalizeDomain(pick('domain', 'DOMAIN')),
    publicUrl: String(pick('publicUrl', 'PUBLIC_URL') || '').trim() || null,
    httpTunnelUrlTemplate: String(pick('httpTunnelUrlTemplate', 'HTTP_TUNNEL_URL_TEMPLATE') || '').trim() || null,
    tlsCert: String(pick('tlsCert', 'TLS_CERT') || '').trim() || null,
    tlsKey: String(pick('tlsKey', 'TLS_KEY') || '').trim() || null,
    allowedOrigins: env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    sessionTtlHours: Number(pick('sessionTtlHours', 'SESSION_TTL_HOURS')) > 0
      ? Number(pick('sessionTtlHours', 'SESSION_TTL_HOURS')) : 12,
    sessionRetentionDays: nonNegativeInt(pick('sessionRetentionDays', 'SESSION_RETENTION_DAYS'), 90),
    tunnelIdleRetentionDays: nonNegativeInt(pick('tunnelIdleRetentionDays', 'TUNNEL_IDLE_RETENTION_DAYS'), 30),
    maxTunnelsPerToken: positiveInt(env.MAX_TUNNELS_PER_TOKEN, 10),
    apiRateLimitPerMin: positiveInt(pick('apiRateLimitPerMin', 'API_RATE_LIMIT_PER_MIN'), DEFAULT_API_RATE_LIMIT),
    updateConfPath: String(pick('updateConfPath', 'TUNNELVAULT_UPDATE_CONF') || '').trim() || DEFAULT_UPDATE_CONF,
    frontendDist: options.frontendDist || path.join(__dirname, '..', '..', 'frontend', 'dist'),
    installDir: String(env.INSTALL_DIR || '').trim() || null,
  };
}

/** Installed/release version: INSTALL_DIR/VERSION, repo-root VERSION, else package.json. */
function readVersion(installDir) {
  const candidates = [];
  if (installDir) candidates.push(path.join(installDir, 'VERSION'));
  candidates.push(path.join(__dirname, '..', '..', 'VERSION'));
  for (const file of candidates) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9A-Za-z.+_-]{1,64}$/.test(v)) return v;
    } catch {}
  }
  try {
    return require('../package.json').version;
  } catch {
    return 'dev';
  }
}

/** Best-effort read of the updater config (ENABLED=1, SCHEDULE="12h"). */
function readAutoUpdate(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { enabled: false, schedule: null };
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    values[m[1]] = v;
  }
  const enabled = /^(1|true|yes|on)$/i.test(values.ENABLED || '');
  const schedule = values.SCHEDULE ? String(values.SCHEDULE).slice(0, 64) : null;
  return { enabled, schedule };
}

function listen(server, port, host, name) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      // Port in use may be transient (previous process still exiting): plain error, systemd retries.
      if (err.code === 'EADDRINUSE') reject(Object.assign(new Error(`${name} ${host}:${port} is already in use`), { code: 'EADDRINUSE' }));
      else if (err.code === 'EACCES') reject(new ConfigError(`No permission to listen on ${host}:${port} (${name})`));
      else if (err.code === 'EADDRNOTAVAIL') reject(new ConfigError(`BIND_HOST ${host} is not an address of this machine`));
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Close a server, force-destroying sockets that are still open after a grace period. */
function closeServer(server, sockets) {
  return new Promise((resolve) => {
    if (!server.listening) {
      for (const s of sockets) s.destroy();
      return resolve();
    }
    const timer = setTimeout(() => {
      for (const s of sockets) s.destroy();
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('secureConnection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return sockets;
}

/**
 * @param {object} [options] - overrides: env, port, proxyPort, bindHost, authToken, nodeEnv, trustProxy,
 *   domain, publicUrl, httpTunnelUrlTemplate, tlsCert, tlsKey, sessionTtlHours, sessionRetentionDays,
 *   tunnelIdleRetentionDays, apiRateLimitPerMin, updateConfPath, frontendDist, db, secretBox,
 *   tcpProxyOptions, sshOptions, wsOptions, maintenanceIntervalMs, closeDbOnStop (default true)
 */
function createTunnelVault(options = {}) {
  const env = options.env || process.env;
  const config = loadConfig(env, options);

  if (!config.authToken) {
    if (config.nodeEnv === 'production') {
      throw new ConfigError('AUTH_TOKEN is not set. Refusing to start in production without authentication '
        + '(set AUTH_TOKEN in the environment file, e.g. /opt/tunnelvault/backend/.env).');
    }
    log.warn('AUTH_TOKEN is not set — all API endpoints are UNAUTHENTICATED (dev mode)');
  } else if (config.authToken.length < 16) {
    log.warn('AUTH_TOKEN is shorter than 16 characters — use a long random token (openssl rand -hex 32)');
  }

  // TLS files are read before anything else is created (clear error, nothing to clean up).
  let tlsOptions = null;
  if (config.tlsCert || config.tlsKey) {
    if (!config.tlsCert || !config.tlsKey) {
      throw new ConfigError('Set both TLS_CERT and TLS_KEY (or neither).');
    }
    try {
      tlsOptions = { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
    } catch (err) {
      throw new ConfigError(`Cannot read the TLS certificate/key (TLS_CERT=${config.tlsCert}, TLS_KEY=${config.tlsKey}): `
        + `${err.code || err.message}${err.path ? ` on ${err.path}` : ''}. The TunnelVault service user must be able to read both files. `
        + 'Files under /etc/letsencrypt are root-only: use install-server.sh --tls (nginx terminates TLS) '
        + 'or copy the certificate to a readable location in a certbot deploy hook.');
    }
  }

  let secretBox = options.secretBox;
  if (!secretBox) {
    try {
      secretBox = loadSecretBoxFromEnv(env);
    } catch (err) {
      if (err instanceof SecretBoxConfigError) throw new ConfigError(err.message);
      throw err;
    }
  }
  if (!secretBox.enabled) {
    log.info('DATA_ENCRYPTION_KEY is not set — storing SSH private keys for the web terminal is disabled');
  }

  initGeoip(env);

  const db = options.db || require('./database');
  const version = readVersion(config.installDir);
  const trustProxy = config.trustProxy;
  const getClientIp = createIpResolver(trustProxy);

  // ─── Core services ─────────────────────────────────────
  const tunnelManager = new TunnelManager(db);
  const connectionTracker = new ConnectionTracker();
  const tcpProxy = new TcpProxy(connectionTracker, db, tunnelManager, options.tcpProxyOptions || {});
  const registry = new ClientRegistry();
  const auth = createAuth({
    db,
    authToken: config.authToken,
    nodeEnv: config.nodeEnv,
    sessionTtlHours: config.sessionTtlHours,
    trustProxy,
    getClientIp: (req) => req.ip || getClientIp(req),
  });
  const maintenance = createMaintenance({
    db,
    tunnelManager,
    sessionRetentionDays: config.sessionRetentionDays,
    tunnelIdleRetentionDays: config.tunnelIdleRetentionDays,
    intervalMs: options.maintenanceIntervalMs,
  });
  const apiLimiter = createRateLimiter({ windowMs: 60_000, max: config.apiRateLimitPerMin });
  const startTime = Date.now();

  // ─── Express app (API + dashboard) ─────────────────────
  const app = express();
  app.disable('x-powered-by');
  // Proxy headers are only honoured when TRUST_PROXY/BEHIND_PROXY says a proxy is in front.
  app.set('trust proxy', trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    const host = typeof req.headers.host === 'string' && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(req.headers.host)
      ? req.headers.host : null;
    const wsSources = host ? ` ws://${host} wss://${host}` : '';
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; "
      + `img-src 'self' data:; connect-src 'self'${wsSources}; object-src 'none'; base-uri 'self'; `
      + "form-action 'self'; frame-ancestors 'none'");
    // HSTS only over HTTPS; no includeSubDomains (tunnel subdomains may be plain HTTP).
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(requestLogger());

  // CORS: never with credentials (the session cookie is same-origin only).
  app.use(cors(config.allowedOrigins ? { origin: config.allowedOrigins, credentials: false } : undefined));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // req.ip is proxy-aware only when trust proxy is configured.
    if (!apiLimiter.hit(req.ip || getClientIp(req))) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many requests', message: 'Rate limit exceeded. Try again later.' });
    }
    return next();
  });

  // Health check (no auth, no details)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Date.now() - startTime });
  });

  app.use('/api', express.json({ limit: '1mb' }));

  // Dashboard login/logout/session (no auth)
  app.use('/api/auth', authRouter(auth));

  // Everything else under /api requires Bearer AUTH_TOKEN or a dashboard session
  app.use('/api', auth.requireAuth);

  function publicConfig() {
    const apiAddr = server.address();
    const proxyAddr = proxyServer.address();
    const proxyPort = (proxyAddr && proxyAddr.port) || config.proxyPort;
    return {
      version,
      domain: config.domain,
      apiPort: (apiAddr && apiAddr.port) || config.port,
      proxyPort,
      tcpPortRange: [tcpProxy.portMin, tcpProxy.portMax],
      publicUrl: config.publicUrl,
      httpTunnelUrlTemplate: config.httpTunnelUrlTemplate || `http://{subdomain}.${config.domain}:${proxyPort}`,
      trustProxy: trustProxy !== false,
      geoipProvider: getGeoipProvider(),
      storedKeysEnabled: !!secretBox.enabled,
      sessionRetentionDays: config.sessionRetentionDays,
      tunnelIdleRetentionDays: config.tunnelIdleRetentionDays,
      maxTunnelsPerToken: config.maxTunnelsPerToken,
      autoUpdate: readAutoUpdate(config.updateConfPath),
    };
  }

  app.use('/api/tunnels', tunnelsRouter(tunnelManager, { db, secretBox }));
  app.use('/api/connections', connectionsRouter(connectionTracker));
  app.use('/api/stats', statsRouter(tunnelManager, connectionTracker, startTime, db));
  app.use('/api/tokens', tokensRouter(db, { registry, tunnelManager, secretBox }));
  app.use('/api/sessions', sessionsRouter(db));
  app.use('/api/config', configRouter(publicConfig));

  // Unknown API routes: JSON 404 (never the SPA)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve static frontend files if they exist
  const frontendPath = config.frontendDist;
  app.use(express.static(frontendPath));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/ws' || req.path.startsWith('/ws/')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'), (err) => {
      if (err && !res.headersSent) {
        // Frontend not built yet, that's fine
        res.status(200).json({ message: 'TunnelVault API is running. Frontend not built yet.' });
      }
    });
  });

  app.use(errorHandler());

  // ─── HTTP(S) server + WebSockets ───────────────────────
  const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
  const apiSockets = trackSockets(server);

  const wsApi = initWebSocket(server, {
    tunnelManager,
    connectionTracker,
    db,
    tcpProxy,
    registry,
    getClientIp,
    authToken: config.authToken || '',
    ...(options.wsOptions || {}),
  });
  const sshApi = initSshWebSocket(server, {
    tunnelManager,
    connectionTracker,
    db,
    auth,
    getClientIp,
    secretBox,
    tcpProxy,
    ...(options.sshOptions || {}),
  });

  // ─── Public HTTP tunnel proxy ──────────────────────────
  let proxyServer;
  try {
    proxyServer = createProxyServer(tunnelManager, connectionTracker, {
      tcpProxy, getClientIp, trustProxy, domain: config.domain,
    });
  } catch (err) {
    // e.g. unreadable TLS_PROXY_CERT: release everything created so far
    wsApi.close();
    sshApi.close();
    tcpProxy.destroy();
    connectionTracker.destroy();
    tunnelManager.destroy();
    auth.destroy();
    apiLimiter.destroy();
    throw new ConfigError(err.message);
  }
  const proxySockets = trackSockets(proxyServer);

  let startPromise = null;
  let stopPromise = null;

  async function start() {
    if (stopPromise) throw new Error('TunnelVault has been stopped');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      migrateStoredKeys(db, secretBox);
      maintenance.runStartup();
      const apiAddr = await listen(server, config.port, config.bindHost, 'PORT');
      const proxyAddr = await listen(proxyServer, config.proxyPort, config.bindHost, 'PROXY_PORT');
      maintenance.start();

      const tls = server instanceof https.Server;
      log.info(`API + dashboard listening on ${tls ? 'https' : 'http'}://${config.bindHost}:${apiAddr.port}`
        + ` (device WebSocket /ws, web terminal /ws/ssh), version ${version}`);
      log.info(`HTTP tunnel proxy listening on ${config.bindHost}:${proxyAddr.port}`);
      if (!tls && trustProxy === false && config.nodeEnv === 'production') {
        log.warn('Serving the dashboard and device WebSocket over plain HTTP: tokens and web-terminal passwords '
          + 'cross the network unencrypted. Install with --tls (nginx + Let\'s Encrypt) or set TLS_CERT/TLS_KEY.');
      }
      return { port: apiAddr.port, proxyPort: proxyAddr.port };
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      maintenance.stop();
      try { wsApi.close(); } catch (err) { log.warn('Error closing device WebSocket server', { error: err.message }); }
      try { sshApi.close(); } catch (err) { log.warn('Error closing web terminal', { error: err.message }); }
      try { tcpProxy.destroy(); } catch (err) { log.warn('Error stopping TCP listeners', { error: err.message }); }
      await Promise.all([closeServer(server, apiSockets), closeServer(proxyServer, proxySockets)]);
      try { connectionTracker.destroy(); } catch {}
      try { tunnelManager.destroy(); } catch (err) { log.warn('Error flushing tunnel stats', { error: err.message }); }
      auth.destroy();
      apiLimiter.destroy();
      if (options.closeDbOnStop !== false && typeof db.close === 'function') {
        try { db.close(); } catch {}
      }
    })();
    return stopPromise;
  }

  return {
    app,
    server,
    proxyServer,
    config,
    version,
    db,
    auth,
    secretBox,
    registry,
    tunnelManager,
    connectionTracker,
    tcpProxy,
    maintenance,
    wsApi,
    sshApi,
    getClientIp,
    publicConfig,
    start,
    stop,
  };
}

module.exports = { createTunnelVault, loadConfig, readVersion, readAutoUpdate, ConfigError };
