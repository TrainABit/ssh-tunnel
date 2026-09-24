'use strict';

/**
 * Browser SSH terminal: WebSocket endpoint /ws/ssh?tunnelId=<id>.
 *
 * Auth: dashboard session cookie + session key (or `Authorization: Bearer <AUTH_TOKEN>`)
 * plus a same-origin Origin check — never a query-string token. Browsers pass the
 * session key as a subprotocol: new WebSocket(url, ['tunnelvault.v1', 'tv-key.<sessionKey>']).
 * The server selects 'tunnelvault.v1' and never echoes the key entry. Upgrades are
 * rate limited per client IP (proxy-aware getClientIp).
 *
 * Protocol (control = JSON text frames, terminal data = BINARY frames both ways):
 *   server  {type:'ready'}
 *   browser {type:'credentials', username, password | privateKey[, passphrase] | useStoredKey:true [, cols, rows]}
 *   server  {type:'hostkey-unknown', fingerprint, keyType}     (first contact: trust on first use)
 *   browser {type:'hostkey-accept'} | {type:'hostkey-reject'}  (within 60 s)
 *   server  {type:'hostkey-mismatch', expected, actual, keyType} + close 1008 (pinned key changed)
 *   server  {type:'connected'}, then raw terminal bytes as binary frames
 *   browser binary frames = keystrokes (UTF-8), {type:'resize', cols, rows} (1..1000)
 *   server  {type:'disconnected'} | {type:'error', message}
 *
 * Host key pins live in ssh_host_keys: pin_key = `token:<clientToken>:<localPort>`
 * for token-owned tunnels (survives tunnel re-creation), else `tunnel:<tunnelId>`.
 * Fingerprint format = OpenSSH 'SHA256:<base64 without padding>'.
 *
 * Transport: the SSH connection runs over a tunnel stream opened directly on the
 * device's WebSocket (tcpProxy.openStream -> tcp-open to the device), NOT through
 * the tunnel's public TCP listener. It therefore works with any TCP_BIND_HOST, does
 * not need the public port, and does not create 127.0.0.1 rows in the sessions log.
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const { createRateLimiter } = require('./rateLimiter');
const { WS_SUBPROTOCOL } = require('./auth');
const { isEncrypted } = require('./secretBox');
const { openTunnelStream } = require('./protocol');
const { createLogger } = require('./logger');
const log = createLogger('ssh-ws');

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_RATE_PER_MIN = 10;
const CRED_TIMEOUT_MS = 30_000;       // time to send credentials after 'ready'
const SSH_TIMEOUT_MS = 10_000;        // TCP + SSH handshake + auth (excluding the host key prompt)
const HOSTKEY_TIMEOUT_MS = 60_000;    // time for the user to accept an unknown host key
const PING_INTERVAL_MS = 30_000;
const WS_MAX_PAYLOAD = 1024 * 1024;
const MAX_CREDENTIALS_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 4 * 1024;
const MAX_USERNAME = 128;
const MAX_PASSWORD = 1024;
const MAX_PRIVATE_KEY = 16 * 1024;
const SEND_HIGH_WATER = 1024 * 1024;  // pause the SSH stream above this ws.bufferedAmount
const SEND_LOW_WATER = 256 * 1024;
const SOCK_CLOSE_GRACE_MS = 5_000;    // destroy the tunnel stream if the SSH peer does not close it

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** OpenSSH-style fingerprint of a raw public key blob. */
function fingerprintOf(keyBlob) {
  return `SHA256:${crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** Key type from an SSH wire-format public key blob (string keyType, ...). */
function keyTypeOf(keyBlob) {
  try {
    if (keyBlob.length < 4) return 'unknown';
    const len = keyBlob.readUInt32BE(0);
    if (len <= 0 || len > 64 || 4 + len > keyBlob.length) return 'unknown';
    const t = keyBlob.subarray(4, 4 + len).toString('latin1');
    return /^[\x21-\x7e]+$/.test(t) ? t : 'unknown';
  } catch {
    return 'unknown';
  }
}

function pinKeyFor(tunnel) {
  return tunnel.clientToken ? `token:${tunnel.clientToken}:${tunnel.localPort}` : `tunnel:${tunnel.id}`;
}

function timingSafeStrEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n`
      + `${status === 429 ? 'Retry-After: 60\r\n' : ''}\r\n`);
  } catch {}
  socket.destroy();
}

function validDimension(n) {
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}

/**
 * Attach the SSH terminal WebSocket endpoint to an HTTP(S) server.
 *
 *   initSshWebSocket(server, { tunnelManager, db, auth, getClientIp, secretBox, tcpProxy,
 *                              connectionTracker?, maxSessions?, rateLimitPerMin?, pingIntervalMs?,
 *                              hostKeyTimeoutMs?, credentialsTimeoutMs?, sshTimeoutMs? })
 *     -> { wss, close(), activeSessions }
 *
 * `auth` is the object from auth.createAuth() (authenticateUpgrade(req)).
 * `tcpProxy.openStream(tunnelId, { onTraffic })` provides the SSH transport (falls back to
 * protocol.openTunnelStream when no tcpProxy is given). `connectionTracker` (optional) lists
 * the web terminal session as a live connection of the tunnel with the browser's IP.
 * Legacy positional form (server, tunnelManager, db, authToken) is still accepted.
 */
function initSshWebSocket(server, deps = {}, ...legacyArgs) {
  if (deps && typeof deps.getTunnel === 'function') {
    const [db, authToken] = legacyArgs;
    deps = { tunnelManager: deps, db, authToken };
  }
  const { tunnelManager, db = null, tcpProxy = null, connectionTracker = null } = deps;
  if (!tunnelManager) throw new TypeError('initSshWebSocket requires deps.tunnelManager');
  let auth = deps.auth;
  if (!auth) {
    // Minimal fallback (legacy callers): Bearer/cookie auth with the given AUTH_TOKEN.
    const { createAuth } = require('./auth');
    auth = createAuth({ db, authToken: deps.authToken || '', nodeEnv: process.env.NODE_ENV });
  }
  const secretBox = deps.secretBox || { enabled: false };
  const getClientIp = typeof deps.getClientIp === 'function'
    ? deps.getClientIp
    : (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
  const maxSessions = deps.maxSessions > 0 ? deps.maxSessions : envInt('WEB_SSH_MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
  const pingIntervalMs = deps.pingIntervalMs > 0 ? deps.pingIntervalMs : PING_INTERVAL_MS;
  const hostKeyTimeoutMs = deps.hostKeyTimeoutMs > 0 ? deps.hostKeyTimeoutMs : HOSTKEY_TIMEOUT_MS;
  const credentialsTimeoutMs = deps.credentialsTimeoutMs > 0 ? deps.credentialsTimeoutMs : CRED_TIMEOUT_MS;
  const sshTimeoutMs = deps.sshTimeoutMs > 0 ? deps.sshTimeoutMs : SSH_TIMEOUT_MS;
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: deps.rateLimitPerMin > 0 ? deps.rateLimitPerMin : envInt('WEB_SSH_RATE_LIMIT_PER_MIN', DEFAULT_RATE_PER_MIN),
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
    // Browsers fail the handshake unless one offered subprotocol is selected. Select
    // only ours: the default (first offered) could echo the tv-key.<sessionKey> entry.
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });
  let activeSessions = 0;
  let closed = false;

  function onUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return;
    }
    if (url.pathname !== '/ws/ssh') return; // handled by other upgrade handlers

    if (closed) return rejectUpgrade(socket, 503, 'Service Unavailable');
    const ip = getClientIp(req) || 'unknown';
    if (!limiter.hit(ip)) {
      log.warn('Web terminal upgrade rate limited', { ip });
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    let result;
    try {
      result = auth.authenticateUpgrade(req);
    } catch (err) {
      log.error('Web terminal auth check failed', { error: err.message });
      result = { ok: false, status: 401 };
    }
    if (!result.ok) {
      const forbidden = result.status === 403;
      log.warn(forbidden ? 'Web terminal upgrade from foreign origin refused' : 'Web terminal upgrade unauthorized', {
        ip, origin: forbidden ? String(req.headers.origin || '').slice(0, 200) : undefined,
      });
      return rejectUpgrade(socket, forbidden ? 403 : 401, forbidden ? 'Forbidden' : 'Unauthorized');
    }

    const tunnelId = url.searchParams.get('tunnelId');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { ip, tunnelId });
    });
  }
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, _req, ctx = {}) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => log.warn('Web terminal WebSocket error', { error: err.message }));

    const { ip = 'unknown', tunnelId = null } = ctx;
    const tunnel = typeof tunnelId === 'string' && tunnelId.length > 0 && tunnelId.length <= 128
      ? tunnelManager.getTunnel(tunnelId) : null;
    if (!tunnel) {
      sendJson(ws, { type: 'error', message: 'Tunnel not found' });
      ws.close(1008, 'Tunnel not found');
      return;
    }
    if (tunnel.protocol !== 'tcp') {
      sendJson(ws, { type: 'error', message: 'Tunnel is not a TCP tunnel' });
      ws.close(1008, 'Not a TCP tunnel');
      return;
    }
    if (tunnel.status !== 'active') {
      sendJson(ws, { type: 'error', message: 'Tunnel is not active' });
      ws.close(1008, 'Tunnel inactive');
      return;
    }
    if (activeSessions >= maxSessions) {
      sendJson(ws, { type: 'error', message: 'Maximum concurrent SSH sessions reached' });
      ws.close(1013, 'Max sessions');
      return;
    }

    // One slot per WebSocket, released exactly once when the socket closes.
    activeSessions++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
    };
    runSession(ws, tunnel, ip, release);
  });

  function runSession(ws, tunnel, ip, release) {
    const tunnelId = tunnel.id;
    const pinKey = pinKeyFor(tunnel);
    let state = 'await-credentials'; // -> connecting -> (await-hostkey -> connecting) -> connected -> closed
    let client = null;
    let sock = null;   // tunnel stream to the device (SSH transport)
    let trackId = null;
    let stream = null;
    let connectTimer = null;
    let pendingHostKey = null; // { fingerprint, keyType, verify, timer }
    let size = { cols: 80, rows: 24 };
    let paused = false;       // SSH output paused (browser socket congested)
    let inputPaused = false;  // browser socket paused (SSH channel congested by a big paste)

    const credTimer = setTimeout(() => fail('Credentials timeout', 1008), credentialsTimeoutMs);

    function cleanup() {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(credTimer);
      clearTimeout(connectTimer);
      if (pendingHostKey) {
        const p = pendingHostKey;
        pendingHostKey = null;
        clearTimeout(p.timer);
        try { p.verify(false); } catch {}
      }
      if (stream) {
        try { stream.close(); } catch {}
      }
      if (client) {
        try { client.end(); } catch {}
      }
      if (sock && !sock.destroyed) {
        // client.end() half-closes the tunnel stream; make sure it goes away even if
        // the SSH server or the device never answers.
        const s = sock;
        const t = setTimeout(() => s.destroy(), SOCK_CLOSE_GRACE_MS);
        t.unref();
        s.once('close', () => clearTimeout(t));
      }
      if (trackId && connectionTracker) {
        try { connectionTracker.completeConnection(trackId); } catch {}
        trackId = null;
      }
      if (inputPaused) {
        inputPaused = false;
        try { ws.resume(); } catch {} // so the closing handshake can complete
      }
    }

    function closeWs(code, reason) {
      cleanup();
      if (ws.readyState === 0 || ws.readyState === 1) {
        try { ws.close(code, reason); } catch {}
      }
    }

    function fail(message, code = 1011) {
      if (state === 'closed') return;
      sendJson(ws, { type: 'error', message });
      closeWs(code, String(message).slice(0, 100));
    }

    ws.on('close', () => {
      cleanup();
      release();
    });

    ws.on('message', (data, isBinary) => {
      if (state === 'closed') return;
      if (isBinary) {
        if (state === 'connected' && stream) {
          try {
            // Backpressure for large pastes: stop reading the browser socket until SSH drains.
            if (!stream.write(data) && !inputPaused) {
              inputPaused = true;
              ws.pause();
              stream.once('drain', () => {
                if (!inputPaused) return;
                inputPaused = false;
                if (state !== 'closed') ws.resume();
              });
            }
          } catch {}
        }
        return;
      }
      const limit = state === 'await-credentials' ? MAX_CREDENTIALS_BYTES : MAX_CONTROL_BYTES;
      if (data.length > limit) {
        fail('Message too large', 1009);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        if (state === 'await-credentials') fail('Invalid credentials message', 1008);
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (state === 'await-credentials') {
        try {
          handleCredentials(msg);
        } catch (err) {
          log.error('Web terminal setup failed', { tunnelId, error: err.message });
          fail('Internal error');
        }
      } else if (msg.type === 'hostkey-accept' || msg.type === 'hostkey-reject') {
        if (state === 'await-hostkey') decideHostKey(msg.type === 'hostkey-accept', 'user');
      } else if (msg.type === 'resize') {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (!validDimension(cols) || !validDimension(rows)) return;
        size = { cols, rows };
        if (stream) {
          try { stream.setWindow(rows, cols, 0, 0); } catch {}
        }
      }
    });

    sendJson(ws, { type: 'ready' });

    function handleCredentials(creds) {
      clearTimeout(credTimer);
      if (creds.type !== 'credentials') {
        fail('Missing credentials', 1008);
        return;
      }
      const username = creds.username;
      if (typeof username !== 'string' || username.length === 0 || username.length > MAX_USERNAME
          || /[\s\x00-\x1f\x7f]/.test(username)) {
        fail('Invalid username', 1008);
        return;
      }
      if (validDimension(Number(creds.cols)) && validDimension(Number(creds.rows))) {
        size = { cols: Number(creds.cols), rows: Number(creds.rows) };
      }

      // Re-check: the device may have gone away while the user typed.
      const current = tunnelManager.getTunnel(tunnelId);
      if (!current || current.protocol !== 'tcp' || current.status !== 'active'
          || pinKeyFor(current) !== pinKey) {
        fail('Tunnel is not active', 1008);
        return;
      }

      // Never log passwords or keys.
      const config = {
        username,
        readyTimeout: sshTimeoutMs + hostKeyTimeoutMs + 5000, // backstop; our own timers are tighter
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key, verify) => verifyHostKey(key, verify),
      };

      if (creds.useStoredKey === true) {
        if (!secretBox.enabled) {
          fail('Stored SSH keys are disabled on this server (DATA_ENCRYPTION_KEY is not set)', 1008);
          return;
        }
        const row = current.clientToken && db
          ? db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [current.clientToken])
          : null;
        if (!row || !row.private_key) {
          fail('No stored SSH key found for this tunnel', 1008);
          return;
        }
        try {
          config.privateKey = isEncrypted(row.private_key) ? secretBox.decrypt(row.private_key) : row.private_key;
        } catch {
          log.error('Stored SSH key could not be decrypted', { tunnelId });
          fail('Stored SSH key could not be decrypted (was DATA_ENCRYPTION_KEY changed?)', 1011);
          return;
        }
      } else if (typeof creds.privateKey === 'string' && creds.privateKey.length > 0) {
        if (creds.privateKey.length > MAX_PRIVATE_KEY) {
          fail('Private key is too large', 1008);
          return;
        }
        config.privateKey = creds.privateKey;
        if (typeof creds.passphrase === 'string' && creds.passphrase.length > 0) {
          if (creds.passphrase.length > MAX_PASSWORD) {
            fail('Passphrase is too long', 1008);
            return;
          }
          config.passphrase = creds.passphrase;
        }
      } else if (typeof creds.password === 'string' && creds.password.length > 0) {
        if (creds.password.length > MAX_PASSWORD) {
          fail('Password is too long', 1008);
          return;
        }
        config.password = creds.password;
        config.tryKeyboard = true; // many servers only offer keyboard-interactive for passwords
      } else {
        fail('No authentication method provided', 1008);
        return;
      }

      // SSH transport: a stream straight to the device (tcp-open to its local port).
      const onTraffic = (bytesIn, bytesOut) => {
        tunnelManager.addBytes(tunnelId, bytesIn + bytesOut);
        if (trackId && connectionTracker) connectionTracker.updateBytes(trackId, bytesIn, bytesOut);
      };
      try {
        sock = tcpProxy && typeof tcpProxy.openStream === 'function'
          ? tcpProxy.openStream(tunnelId, { onTraffic })
          : openTunnelStream(current, { onTraffic });
      } catch (err) {
        log.warn('Could not open a tunnel stream for the web terminal', { tunnelId, error: err.message });
        sock = null;
      }
      if (!sock) {
        fail('Device is not connected', 1011);
        return;
      }
      sock.on('error', (err) => log.debug('Web terminal tunnel stream error', { tunnelId, error: err.message }));
      if (connectionTracker) {
        try { trackId = connectionTracker.startConnection(tunnelId, ip); } catch {}
      }
      config.sock = sock;

      state = 'connecting';
      connect(config);
    }

    function startConnectTimer() {
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => fail('SSH connection timed out'), sshTimeoutMs);
    }

    function connect(config) {
      client = new Client();
      const password = config.password;

      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // Answer password prompts with the supplied password; nothing else.
        finish(prompts.map(() => (password || '')));
      });

      client.on('ready', () => {
        if (state === 'closed') return;
        clearTimeout(connectTimer);
        log.info('Web terminal session established', { tunnelId, ip });
        client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, shellStream) => {
          if (state === 'closed') {
            if (shellStream) { try { shellStream.close(); } catch {} }
            return;
          }
          if (err) {
            log.warn('Web terminal shell error', { tunnelId, error: err.message });
            fail(`Shell error: ${err.message}`);
            return;
          }
          stream = shellStream;
          state = 'connected';
          sendJson(ws, { type: 'connected' });

          const onData = (chunk) => {
            if (ws.readyState !== 1) return;
            ws.send(chunk, { binary: true }, afterSend);
            if (!paused && ws.bufferedAmount > SEND_HIGH_WATER) {
              paused = true;
              stream.pause();
              if (stream.stderr) stream.stderr.pause();
            }
          };
          stream.on('data', onData);
          if (stream.stderr) stream.stderr.on('data', onData);
          stream.on('close', () => {
            if (state === 'closed') return;
            sendJson(ws, { type: 'disconnected' });
            closeWs(1000, 'SSH session closed');
          });
          stream.on('error', (e) => log.debug('Web terminal stream error', { tunnelId, error: e.message }));
        });
      });

      client.on('error', (err) => {
        if (state === 'closed') return;
        log.warn('Web terminal SSH error', { tunnelId, level: err.level, error: err.message });
        fail(`SSH error: ${err.message}`);
      });

      client.on('close', () => {
        if (state === 'closed') return;
        sendJson(ws, { type: 'disconnected' });
        closeWs(1000, 'SSH connection closed');
      });

      startConnectTimer();
      try {
        client.connect(config);
      } catch (err) {
        log.warn('Web terminal SSH connect failed', { tunnelId, error: err.message });
        fail(`Connect error: ${err.message}`);
      }
    }

    function afterSend() {
      if (paused && stream && ws.bufferedAmount < SEND_LOW_WATER) {
        paused = false;
        stream.resume();
        if (stream.stderr) stream.stderr.resume();
      }
    }

    function lookupPin() {
      return db ? db.queryOne('SELECT fingerprint, key_type FROM ssh_host_keys WHERE pin_key = ?', [pinKey]) : null;
    }

    // NOTE: verify(false) makes ssh2 emit 'error' synchronously, so the session
    // is closed first (state 'closed' suppresses the generic SSH error message).
    function reportMismatch(expected, actual, keyType, verify) {
      log.warn('Web terminal host key MISMATCH — refusing to connect', { tunnelId, expected, actual, keyType });
      sendJson(ws, { type: 'hostkey-mismatch', expected, actual, keyType });
      closeWs(1008, 'Host key mismatch');
      try { verify(false); } catch {}
    }

    function verifyHostKey(key, verify) {
      if (state === 'closed') {
        try { verify(false); } catch {}
        return;
      }
      const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
      const fingerprint = fingerprintOf(blob);
      const keyType = keyTypeOf(blob);
      let pin;
      try {
        pin = lookupPin();
      } catch (err) {
        log.error('Host key lookup failed', { error: err.message });
        fail('Host key verification failed');
        try { verify(false); } catch {}
        return;
      }
      if (pin) {
        if (timingSafeStrEqual(pin.fingerprint, fingerprint)) {
          verify(true);
          return;
        }
        reportMismatch(pin.fingerprint, fingerprint, keyType, verify);
        return;
      }
      // Unknown host: ask the user (trust on first use).
      clearTimeout(connectTimer);
      state = 'await-hostkey';
      pendingHostKey = {
        fingerprint,
        keyType,
        verify,
        timer: setTimeout(() => decideHostKey(false, 'timeout'), hostKeyTimeoutMs),
      };
      sendJson(ws, { type: 'hostkey-unknown', fingerprint, keyType });
    }

    function decideHostKey(accept, why) {
      if (!pendingHostKey) return;
      const p = pendingHostKey;
      pendingHostKey = null;
      clearTimeout(p.timer);
      if (!accept) {
        fail(why === 'timeout' ? 'Host key confirmation timed out' : 'Host key rejected', 1008);
        try { p.verify(false); } catch {}
        return;
      }
      try {
        db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?) ON CONFLICT(pin_key) DO NOTHING',
          [pinKey, p.keyType, p.fingerprint]);
        const pin = lookupPin();
        if (pin && !timingSafeStrEqual(pin.fingerprint, p.fingerprint)) {
          // Another session pinned a different key in the meantime.
          reportMismatch(pin.fingerprint, p.fingerprint, p.keyType, p.verify);
          return;
        }
      } catch (err) {
        log.error('Could not store host key pin', { error: err.message });
        fail('Could not store host key');
        try { p.verify(false); } catch {}
        return;
      }
      log.info('Web terminal host key pinned', { tunnelId, fingerprint: p.fingerprint, keyType: p.keyType });
      state = 'connecting';
      startConnectTimer();
      p.verify(true);
    }
  }

  // Keep browser sockets alive through proxies and drop dead peers.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, pingIntervalMs);
  pingTimer.unref();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    server.removeListener('upgrade', onUpgrade);
    limiter.destroy();
    for (const ws of wss.clients) {
      try { ws.close(1001, 'Server shutting down'); } catch {}
      const t = setTimeout(() => { try { ws.terminate(); } catch {} }, 1000);
      t.unref();
    }
    wss.close();
  }

  log.info('SSH WebSocket handler initialized on /ws/ssh');
  return {
    wss,
    close,
    get activeSessions() { return activeSessions; },
  };
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

module.exports = { initSshWebSocket, fingerprintOf, keyTypeOf, pinKeyFor };
