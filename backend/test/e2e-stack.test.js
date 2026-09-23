'use strict';

/**
 * End-to-end: the full server (createTunnelVault, as started by server.js) with
 * the REAL device client (client/src/tunnel.js) on loopback.
 *
 * Device token created through the API; the client exposes a TCP echo service,
 * an HTTP app (cookies + a WebSocket endpoint) and an SSH server. Checked:
 *   - TCP echo through the public port, 24 MiB with sha256 integrity
 *   - HTTP through the proxy port by Host header (Set-Cookie passes, Domain stripped,
 *     request cookies and X-Forwarded-* reach the app), 8 MiB upload, WebSocket upgrade
 *   - dashboard cookie login + web terminal (/ws/ssh) through the device: unknown host
 *     key -> accept -> connected, UTF-8 output/input byte-exact, stored encrypted key login
 *   - remote reboot is ignored by a device that did not opt in; pause/resume from the dashboard
 *   - token deactivation closes the client within 5 s and the public port stops accepting;
 *     reactivation -> the client reconnects and keeps the SAME public TCP port
 *   - client restart with its saved state keeps the ports; token deletion removes everything
 *
 * Runs in its own `node --test` process: the environment below must be set before
 * anything loads src/database.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { once } = require('events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-e2e-'));
const AUTH_TOKEN = crypto.randomBytes(24).toString('hex');
const DOMAIN = 'e2e.test';

/**
 * Public TCP port window above the kernel's ephemeral range (default 32768-60999), so no
 * listen(0)/outgoing socket and no other test file (they use 20000-49999) can take a port
 * while the device is offline — the "same port after reconnect" checks depend on that.
 */
function tcpPortWindow() {
  let hi = 60999;
  try {
    const [, max] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (Number.isInteger(max)) hi = max;
  } catch {}
  const base = hi <= 64000 ? hi + 1 : 50000;
  const min = base + Math.floor(Math.random() * 40) * 25;
  return { min, max: min + 24 };
}

for (const key of [
  'TRUST_PROXY', 'BEHIND_PROXY', 'DATA_ENCRYPTION_KEY_FILE', 'DATA_ENCRYPTION_KEY_PREVIOUS',
  'DATA_ENCRYPTION_KEY_PREVIOUS_FILE', 'GEOIP_DB', 'USERMGR_SPOOL_DIR', 'WEBHOOK_URL', 'TLS_CERT', 'TLS_KEY',
  'TLS_PROXY_CERT', 'TLS_PROXY_KEY', 'PUBLIC_URL', 'ALLOWED_ORIGINS', 'INSTALL_DIR', 'LOG_FILE', 'LOG_FORMAT',
  'SESSION_RETENTION_DAYS', 'TUNNEL_IDLE_RETENTION_DAYS', 'SESSION_TTL_HOURS', 'API_RATE_LIMIT_PER_MIN',
  'WEB_SSH_RATE_LIMIT_PER_MIN', 'WEB_SSH_MAX_SESSIONS', 'MAX_TUNNELS_PER_TOKEN', 'MAX_CONNECTIONS_PER_TOKEN',
  'WS_UPGRADE_RATE_MAX', 'WS_AUTH_FAIL_MAX', 'HTTP_PROXY_IDLE_TIMEOUT_MS', 'TCP_MAX_CONNECTIONS_PER_TUNNEL',
  'TUNNELVAULT_ALLOW_REBOOT', 'TUNNELVAULT_STATE_DIR', 'TUNNELVAULT_CONFIG', 'TUNNELVAULT_SERVER',
  'TUNNELVAULT_AUTH_TOKEN',
]) {
  delete process.env[key];
}
const PORT_WINDOW = tcpPortWindow();
Object.assign(process.env, {
  NODE_ENV: 'production',
  LOG_LEVEL: process.env.LOG_LEVEL || 'fatal',
  DB_PATH: path.join(TMP_DIR, 'tunnelvault.db'),
  AUTH_TOKEN,
  DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  PORT: '0',
  PROXY_PORT: '0',
  BIND_HOST: '127.0.0.1',
  TCP_BIND_HOST: '127.0.0.1',
  TCP_PORT_MIN: String(PORT_WINDOW.min),
  TCP_PORT_MAX: String(PORT_WINDOW.max),
  DOMAIN,
  HTTP_TUNNEL_URL_TEMPLATE: `http://{subdomain}.${DOMAIN}`,
  GEOIP_PROVIDER: 'off',
  TUNNELVAULT_UPDATE_CONF: path.join(TMP_DIR, 'update.conf'),
});

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const { createTunnelVault } = require('../src/app');
const { fingerprintOf } = require('../src/sshWsHandler');
const { generateKeyPair } = require('./helpers/ssh-keys');

const HOST_KEY = generateKeyPair('ed25519');
const USER_KEY = generateKeyPair('ed25519');
const USER_PUB = sshUtils.parseKey(USER_KEY.public);
const HOST_FP = fingerprintOf(sshUtils.parseKey(HOST_KEY.public).getPublicSSH());
const GREETING = 'Grüße aus dem Gerät ✓ 🚀 日本\r\n';

// ─── helpers ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll fn() (cheap, in-process) until truthy. */
async function waitUntil(fn, timeoutMs, what) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(20);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    // ssh2's Server has no `listening` flag: always close (the callback also runs if not listening).
    server.close(() => resolve());
  });
}

/** Raw HTTP request (lets us set Host); returns { status, headers, body: Buffer }. */
function httpRequest({ port, method = 'GET', path: urlPath = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('HTTP request timed out')));
    req.end(body);
  });
}

/** TCP connect: resolves 'connected' or the error code (e.g. 'ECONNREFUSED'). */
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (err) => resolve(err.code));
  });
}

/** Send `payload` through an echo tunnel; returns the sha256 of what came back. */
function echoThrough(port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const hash = crypto.createHash('sha256');
    let n = 0;
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`echo stalled after ${n} bytes`)); }, 30000);
    s.on('data', (c) => {
      hash.update(c);
      n += c.length;
      if (n >= payload.length) {
        clearTimeout(timer);
        s.end();
        resolve({ bytes: n, sha256: hash.digest('hex') });
      }
    });
    s.on('error', (err) => { clearTimeout(timer); reject(err); });
    s.write(payload);
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ─── local services behind the device ───────────────────

function startEchoServer() {
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.pipe(s);
  });
  return listen(server).then((port) => ({ server, port }));
}

function startHttpApp() {
  const wss = new WebSocket.Server({ noServer: true });
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload') {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      req.on('data', (c) => { hash.update(c); bytes += c.length; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ bytes, sha256: hash.digest('hex') }));
      });
      return;
    }
    res.setHeader('Set-Cookie', [
      `app_session=s3cr3t; Domain=${DOMAIN}; Path=/; HttpOnly; SameSite=Lax`,
      'theme=dark; Path=/; domain=.web.e2e.test',
    ]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/echo') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  return listen(server).then((port) => ({ server, wss, port }));
}

/** SSH server: password e2e/pw, publickey keyuser/USER_KEY; shell greets (UTF-8, split) and echoes input. */
function startSshServer() {
  const state = { streams: new Set(), input: [], logins: [] };
  const server = new SshServer({ hostKeys: [HOST_KEY.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'e2e' && ctx.password === 'pw') {
        state.logins.push('password');
        return ctx.accept();
      }
      if (ctx.method === 'publickey' && ctx.username === 'keyuser'
          && ctx.key.algo === USER_PUB.type && ctx.key.data.equals(USER_PUB.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (USER_PUB.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
          state.logins.push('publickey');
          return ctx.accept();
        }
      }
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty && acceptPty());
        session.on('window-change', (acceptWc) => acceptWc && acceptWc());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          state.streams.add(stream);
          stream.on('close', () => state.streams.delete(stream));
          // Greeting split inside multi-byte sequences, then echo whatever is typed.
          const bytes = Buffer.from(GREETING, 'utf8');
          const cuts = [2, 7, 20, 27, bytes.length];
          let prev = 0;
          (async () => {
            for (const cut of cuts) {
              if (!stream.writable) return;
              stream.write(bytes.subarray(prev, cut));
              prev = cut;
              await sleep(10);
            }
            stream.on('data', (d) => {
              state.input.push(Buffer.from(d));
              if (stream.writable) stream.write(d);
            });
          })();
        });
      });
    });
  });
  return listen(server).then((port) => ({ server, state, port }));
}

// ─── the test ────────────────────────────────────────────

describe('end-to-end: server + real device client', { timeout: 60_000 }, () => {
  let vault;
  let apiPort;
  let proxyPort;
  let origin;
  let TunnelClient;
  let QuietDisplay;
  let echo;
  let app;
  let ssh;
  let deviceToken;
  let client = null;
  const clientStateDir = path.join(TMP_DIR, 'device-state');
  const clientLogs = [];
  const rebootCalls = [];
  let cookie = null;
  const ids = {};    // localPort role -> tunnel id
  const ports = {};  // role -> public TCP port

  function api(method, urlPath, { body, useCookie = false } = {}) {
    const headers = { accept: 'application/json' };
    if (useCookie) {
      headers.cookie = cookie;
      headers.origin = origin;
    } else {
      headers.authorization = `Bearer ${AUTH_TOKEN}`;
    }
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return httpRequest({ port: apiPort, method, path: urlPath, headers, body: payload }).then((r) => {
      let json = null;
      try { json = JSON.parse(r.body.toString('utf8')); } catch {}
      return { ...r, json };
    });
  }

  function newClient() {
    return new TunnelClient({
      server: `ws://127.0.0.1:${apiPort}`,
      authToken: deviceToken,
      tunnels: [
        { port: echo.port, protocol: 'tcp', name: 'echo' },
        { port: app.port, protocol: 'http', name: 'web', subdomain: 'web' },
        { port: ssh.port, protocol: 'tcp', name: 'ssh' },
      ],
      display: new QuietDisplay({ onLog: (level, msg) => clientLogs.push({ t: Date.now(), level, msg }) }),
      stateDir: clientStateDir,
      localHost: '127.0.0.1',
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 400,
      stableConnectionMs: 1000,
      exec: (file, args, cb) => { rebootCalls.push([file, ...args]); cb(null); },
    });
  }

  /** In-process view (cheap to poll): the device's tunnels, keyed by role. */
  function deviceTunnels() {
    const out = {};
    for (const t of vault.tunnelManager.tunnels.values()) {
      if (t.clientToken !== deviceToken) continue;
      if (t.localPort === echo.port) out.echo = t;
      else if (t.localPort === app.port) out.web = t;
      else if (t.localPort === ssh.port) out.ssh = t;
    }
    return out;
  }

  function allActive() {
    const t = deviceTunnels();
    return t.echo && t.web && t.ssh
      && [t.echo, t.web, t.ssh].every((x) => x.status === 'active' && x.clientWs)
      && t.echo.allocatedPort && t.ssh.allocatedPort
      && vault.tcpProxy.getPort(t.echo.id) && vault.tcpProxy.getPort(t.ssh.id) ? t : null;
  }

  function openTerminal(tunnelId) {
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/ws/ssh?tunnelId=${encodeURIComponent(tunnelId)}`, {
      headers: { cookie }, origin,
    });
    const messages = [];
    const frames = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) frames.push(Buffer.from(data));
      else messages.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('error', () => {});
    const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    return {
      ws,
      frames,
      messages,
      closed,
      opened: once(ws, 'open'),
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFor: (type, timeoutMs = 10000) => waitUntil(() => {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return messages.splice(i, 1)[0];
        const bad = messages.find((m) => m.type === 'error' || m.type === 'hostkey-mismatch');
        if (bad && type !== 'error') throw new Error(`got ${JSON.stringify(bad)} while waiting for ${type}`);
        return null;
      }, timeoutMs, `terminal message '${type}'`),
      output: () => Buffer.concat(frames),
    };
  }

  before(async () => {
    try {
      ({ TunnelClient } = await import('../../client/src/tunnel.js'));
      ({ QuietDisplay } = await import('../../client/src/display.js'));
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('This end-to-end test runs the real device client: install its dependencies first '
          + `(cd client && npm ci). ${err.message}`);
      }
      throw err;
    }
    [echo, app, ssh] = await Promise.all([startEchoServer(), startHttpApp(), startSshServer()]);

    vault = createTunnelVault();
    ({ port: apiPort, proxyPort } = await vault.start());
    origin = `http://127.0.0.1:${apiPort}`;
  });

  after(async () => {
    if (client) await client.disconnect().catch(() => {});
    for (const s of ssh ? ssh.state.streams : []) s.close();
    if (vault) await vault.stop();
    if (app) {
      for (const c of app.wss.clients) c.terminate();
      app.wss.close();
    }
    await Promise.all([closeServer(echo && echo.server), closeServer(app && app.server), closeServer(ssh && ssh.server)]);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('device token created via the API; the real client registers tcp, http and ssh tunnels', async () => {
    const created = await api('POST', '/api/tokens', { body: { label: 'e2e-device' } });
    assert.equal(created.status, 201, created.body.toString());
    deviceToken = created.json.token;
    assert.match(deviceToken, /^[A-Za-z0-9]{20}$/);

    client = newClient();
    client.connect();
    const t = await waitUntil(allActive, 10000, 'all three tunnels active');
    ids.echo = t.echo.id;
    ids.web = t.web.id;
    ids.ssh = t.ssh.id;
    ports.echo = t.echo.allocatedPort;
    ports.ssh = t.ssh.allocatedPort;
    assert.equal(t.echo.clientWs.protocolVersion, 2, 'protocol v2 negotiated');
    for (const p of [ports.echo, ports.ssh]) {
      assert.ok(p >= PORT_WINDOW.min && p <= PORT_WINDOW.max, `public port ${p} in TCP_PORT_MIN..MAX`);
    }

    const list = await api('GET', '/api/tunnels');
    assert.equal(list.status, 200);
    const mine = list.json.tunnels.filter((x) => x.clientToken === deviceToken);
    assert.equal(mine.length, 3);
    const web = mine.find((x) => x.id === ids.web);
    assert.equal(web.protocol, 'http');
    assert.equal(web.subdomain, 'web');
    assert.equal(web.publicUrl, `http://web.${DOMAIN}`);
    for (const x of mine) {
      assert.equal(x.status, 'active');
      assert.equal(x.has_private_key, false);
      assert.equal(x.host_key_fingerprint, null);
      assert.ok(!('ownerSecret' in x));
    }

    // /api/config: every field the dashboard reads (Settings, Tokens install command, Tunnels).
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.status, 200);
    assert.deepEqual(Object.keys(cfg.json).sort(), [
      'apiPort', 'autoUpdate', 'domain', 'geoipProvider', 'httpTunnelUrlTemplate', 'maxTunnelsPerToken', 'proxyPort',
      'publicUrl', 'sessionRetentionDays', 'storedKeysEnabled', 'tcpPortRange', 'trustProxy', 'tunnelIdleRetentionDays',
      'version',
    ]);
    assert.equal(cfg.json.version, fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim());
    assert.equal(cfg.json.domain, DOMAIN);
    assert.equal(cfg.json.apiPort, apiPort);
    assert.equal(cfg.json.proxyPort, proxyPort);
    assert.deepEqual(cfg.json.tcpPortRange, [PORT_WINDOW.min, PORT_WINDOW.max]);
    assert.equal(cfg.json.storedKeysEnabled, true);
    assert.equal(cfg.json.trustProxy, false);
    assert.equal(cfg.json.geoipProvider, 'off');
    assert.equal(cfg.json.httpTunnelUrlTemplate, `http://{subdomain}.${DOMAIN}`);
    assert.deepEqual(cfg.json.autoUpdate, { enabled: false, schedule: null });

    // Saved state: owner secrets (keep the ports stable) in a private file.
    const stateFile = path.join(clientStateDir, 'state.json');
    await waitUntil(() => fs.existsSync(stateFile), 5000, 'state.json');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(clientStateDir).mode & 0o777, 0o700);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(JSON.stringify(saved).includes(ids.echo));
    assert.ok(!JSON.stringify(saved).includes(deviceToken), 'state.json never contains the token');
  });

  test('TCP tunnel: 24 MiB echo through the public port arrives intact', async (t) => {
    const payload = crypto.randomBytes(24 * 1024 * 1024);
    const t0 = Date.now();
    const got = await echoThrough(ports.echo, payload);
    const secs = (Date.now() - t0) / 1000;
    assert.equal(got.bytes, payload.length);
    assert.equal(got.sha256, sha256(payload));
    t.diagnostic(`echo through the real client: ${((2 * payload.length) / 1048576 / secs).toFixed(0)} MiB/s (both directions)`);

    // Dashboard stats count each tunnelled byte once (24 MiB to the device + 24 MiB back).
    const stats = await api('GET', '/api/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.json.bytesTransferred, 2 * payload.length);
    const echoRow = (await api('GET', `/api/tunnels/${ids.echo}`)).json.tunnel;
    assert.equal(echoRow.bytesTransferred, 2 * payload.length);
    assert.equal(echoRow.connections, 1);

    // Sessions log: one row per public TCP connection, attributed to token and tunnel.
    const sessions = await api('GET', '/api/sessions');
    const rows = sessions.json.sessions.filter((x) => x.tunnel_id === ids.echo);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, deviceToken);
    assert.equal(rows[0].token_label, 'e2e-device');
    assert.equal(rows[0].tunnel_name, 'e2e-device');
    assert.equal(rows[0].client_ip, '127.0.0.1');
    assert.equal(rows[0].target_port, echo.port);
    assert.ok(stats.json.recent_sessions.some((x) => x.tunnel_id === ids.echo && x.tunnel_name === 'e2e-device'));
  });

  test('HTTP tunnel via the proxy port by Host: cookies pass (Domain stripped), forwarding headers, upload', async () => {
    const host = `web.${DOMAIN}`;
    const r = await httpRequest({
      port: proxyPort, path: '/hello?x=1', headers: { host, cookie: 'client_cookie=abc; other=1' },
    });
    assert.equal(r.status, 200, r.body.toString());
    const echoed = JSON.parse(r.body.toString('utf8'));
    assert.equal(echoed.url, '/hello?x=1');
    assert.equal(echoed.headers.cookie, 'client_cookie=abc; other=1', 'request cookies reach the app');
    assert.equal(echoed.headers.host, host);
    assert.equal(echoed.headers['x-forwarded-host'], host);
    assert.equal(echoed.headers['x-forwarded-proto'], 'http');
    assert.equal(echoed.headers['x-forwarded-for'], '127.0.0.1');
    const setCookie = r.headers['set-cookie'];
    assert.deepEqual(setCookie, [
      'app_session=s3cr3t; Path=/; HttpOnly; SameSite=Lax',
      'theme=dark; Path=/',
    ], 'Set-Cookie passes with the Domain attribute removed');

    // Streaming request body through the tunnel
    const upload = crypto.randomBytes(8 * 1024 * 1024);
    const up = await httpRequest({
      port: proxyPort, method: 'POST', path: '/upload', headers: { host, 'content-type': 'application/octet-stream' }, body: upload,
    });
    assert.equal(up.status, 200);
    assert.deepEqual(JSON.parse(up.body.toString()), { bytes: upload.length, sha256: sha256(upload) });

    // Unknown subdomain / dashboard host are not routed to the tunnel
    assert.equal((await httpRequest({ port: proxyPort, path: '/', headers: { host: `nope.${DOMAIN}` } })).status, 404);
  });

  test('WebSocket through the HTTP tunnel', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/echo`, { headers: { host: `web.${DOMAIN}` } });
    ws.on('error', () => {});
    await once(ws, 'open');
    const text = 'hallo über den Tunnel 🚀';
    const bin = crypto.randomBytes(300 * 1024);
    const received = [];
    ws.on('message', (d, isBinary) => received.push({ d: Buffer.from(d), isBinary }));
    ws.send(text);
    ws.send(bin);
    await waitUntil(() => received.length >= 2, 10000, 'websocket echo');
    assert.equal(received[0].isBinary, false);
    assert.equal(received[0].d.toString('utf8'), text);
    assert.equal(received[1].isBinary, true);
    assert.ok(received[1].d.equals(bin));
    ws.close();
    await once(ws, 'close');
  });

  test('dashboard cookie login + web terminal through the real device (TOFU, UTF-8 byte-exact)', async () => {
    const login = await httpRequest({
      port: apiPort, method: 'POST', path: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    assert.equal(login.status, 200);
    const setCookie = [].concat(login.headers['set-cookie'] || []);
    assert.equal(setCookie.length, 1);
    assert.match(setCookie[0], /^tv_session=[A-Za-z0-9_-]{43}; /);
    assert.match(setCookie[0], /HttpOnly/i);
    assert.match(setCookie[0], /SameSite=Strict/i);
    cookie = setCookie[0].split(';')[0];
    const session = await httpRequest({ port: apiPort, path: '/api/auth/session', headers: { cookie } });
    assert.deepEqual(JSON.parse(session.body.toString()), { authenticated: true, authRequired: true });

    const t = openTerminal(ids.ssh);
    await t.opened;
    await t.waitFor('ready');
    t.send({ type: 'credentials', username: 'e2e', password: 'pw', cols: 120, rows: 40 });
    const unknown = await t.waitFor('hostkey-unknown');
    assert.equal(unknown.fingerprint, HOST_FP);
    assert.equal(unknown.keyType, 'ssh-ed25519');
    t.send({ type: 'hostkey-accept' });
    await t.waitFor('connected');

    const greeting = Buffer.from(GREETING, 'utf8');
    await waitUntil(() => t.output().length >= greeting.length, 10000, 'greeting');
    assert.ok(t.output().equals(greeting), `terminal output ${JSON.stringify(t.output().toString('utf8'))}`);

    const typed = Buffer.from('echo "Größe: 5 € — 🚀"\r', 'utf8');
    t.frames.length = 0;
    t.ws.send(typed.subarray(0, 14)); // split inside 'ö' / '€' is fine: raw bytes
    t.ws.send(typed.subarray(14));
    await waitUntil(() => t.output().length >= typed.length, 10000, 'echoed input');
    assert.ok(t.output().equals(typed), 'typed UTF-8 echoed byte-exact');
    assert.ok(Buffer.concat(ssh.state.input).equals(typed), 'SSH server received the exact bytes');

    // The web terminal runs over the device WebSocket: listed as a live connection of the
    // tunnel, no sessions row (the public TCP port of the ssh tunnel was never used).
    assert.equal(vault.connectionTracker.getConnections(ids.ssh).length, 1);
    assert.equal(vault.db.queryOne('SELECT COUNT(*) AS n FROM sessions WHERE tunnel_id = ?', [ids.ssh]).n, 0);

    t.ws.close();
    assert.equal(await t.closed, 1005);
    const list = await api('GET', '/api/tunnels');
    assert.equal(list.json.tunnels.find((x) => x.id === ids.ssh).host_key_fingerprint, HOST_FP);
  });

  test('stored (encrypted) SSH key: saved via the dashboard, login through the device without a prompt', async () => {
    const patch = await api('PATCH', `/api/tokens/${deviceToken}`, { useCookie: true, body: { private_key: USER_KEY.private } });
    assert.equal(patch.status, 200, patch.body.toString());
    assert.equal(patch.json.token.has_private_key, true);
    assert.ok(!patch.body.toString().includes('PRIVATE KEY'));
    const stored = vault.db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [deviceToken]).private_key;
    assert.ok(stored.startsWith('tvenc:v1:'), 'encrypted at rest');

    const list = await api('GET', '/api/tunnels');
    assert.equal(list.json.tunnels.find((x) => x.id === ids.ssh).has_private_key, true);

    const t = openTerminal(ids.ssh);
    await t.opened;
    await t.waitFor('ready');
    t.send({ type: 'credentials', username: 'keyuser', useStoredKey: true });
    await t.waitFor('connected'); // host key pinned -> no prompt
    assert.ok(!t.messages.some((m) => m.type === 'hostkey-unknown'));
    assert.equal(ssh.state.logins.at(-1), 'publickey');
    const greeting = Buffer.from(GREETING, 'utf8');
    await waitUntil(() => t.output().length >= greeting.length, 10000, 'greeting');
    t.ws.close();
    await t.closed;
  });

  test('remote reboot is ignored by a device that did not opt in', async () => {
    const r = await api('POST', `/api/tunnels/${ids.echo}/reboot`);
    assert.equal(r.status, 202);
    await waitUntil(() => clientLogs.some((l) => /Ignored remote reboot request/.test(l.msg)), 5000, 'reboot ignored log');
    await sleep(100);
    assert.deepEqual(rebootCalls, []);
  });

  test('pause/resume from the dashboard: standby on the device, same public port after resume', async () => {
    const paused = await api('POST', `/api/tunnels/${ids.echo}/toggle`);
    assert.equal(paused.status, 200);
    assert.equal(paused.json.tunnel.status, 'paused');
    // The device reconnects; the paused tunnel is held in standby, the others come back.
    await waitUntil(() => {
      const t = deviceTunnels();
      return t.echo.status === 'paused' && t.echo.clientWs && t.ssh.status === 'active' && t.ssh.clientWs
        && vault.tcpProxy.getPort(t.ssh.id) === ports.ssh;
    }, 10000, 'standby after pause');
    assert.equal(vault.tcpProxy.getPort(ids.echo), null);
    assert.equal(await probePort(ports.echo), 'ECONNREFUSED');
    await waitUntil(() => clientLogs.some((l) => /is paused \(resume from dashboard\)/.test(l.msg)), 5000, 'standby log');

    const resumed = await api('POST', `/api/tunnels/${ids.echo}/toggle`);
    assert.equal(resumed.status, 200);
    const t = await waitUntil(allActive, 10000, 'tunnels active after resume');
    assert.equal(t.echo.allocatedPort, ports.echo);
    assert.equal(t.ssh.allocatedPort, ports.ssh);
    const payload = crypto.randomBytes(256 * 1024);
    assert.equal((await echoThrough(ports.echo, payload)).sha256, sha256(payload));
  });

  test('token deactivation closes the client within 5 s; the public port stops accepting', async () => {
    const t0 = Date.now();
    const r = await api('PATCH', `/api/tokens/${deviceToken}`, { body: { active: 0 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.disconnected, 1);
    await waitUntil(() => clientLogs.some((l) => l.t >= t0 && /token revoked or invalid/.test(l.msg)), 5000,
      'client reports the revoked token');
    await waitUntil(() => vault.registry.connectionsForToken(deviceToken).length === 0, 5000, 'server side closed');
    assert.ok(Date.now() - t0 < 5000, `closed after ${Date.now() - t0} ms`);
    await waitUntil(() => !vault.tcpProxy.getPort(ids.echo) && !vault.tcpProxy.getPort(ids.ssh), 5000, 'listeners stopped');
    assert.equal(await probePort(ports.echo), 'ECONNREFUSED');
    assert.equal(await probePort(ports.ssh), 'ECONNREFUSED');
    const web = await httpRequest({ port: proxyPort, path: '/', headers: { host: `web.${DOMAIN}` } });
    assert.ok(web.status >= 500, `http tunnel offline -> ${web.status}`);

    // The client keeps retrying; the server keeps refusing the deactivated token.
    const refusalsBefore = clientLogs.filter((l) => /token revoked or invalid/.test(l.msg)).length;
    await waitUntil(() => clientLogs.filter((l) => /token revoked or invalid/.test(l.msg)).length > refusalsBefore,
      5000, 'a refused retry (HTTP 401)');
    assert.equal(vault.registry.connectionsForToken(deviceToken).length, 0);
    for (const t of Object.values(deviceTunnels())) assert.equal(t.status, 'inactive');
  });

  test('reactivation: the client reconnects and keeps the SAME public TCP ports', async () => {
    const r = await api('PATCH', `/api/tokens/${deviceToken}`, { body: { active: 1 } });
    assert.equal(r.status, 200);
    const t = await waitUntil(allActive, 10000, 'tunnels active again');
    assert.equal(t.echo.id, ids.echo, 'same tunnel (reconnect, not a new registration)');
    assert.equal(t.ssh.id, ids.ssh);
    assert.equal(t.web.id, ids.web);
    assert.equal(t.echo.allocatedPort, ports.echo);
    assert.equal(t.ssh.allocatedPort, ports.ssh);
    const payload = crypto.randomBytes(1024 * 1024);
    assert.equal((await echoThrough(ports.echo, payload)).sha256, sha256(payload));
  });

  test('client restart with its saved state keeps the ports', async () => {
    await client.disconnect();
    client = null;
    await waitUntil(() => vault.registry.connectionsForToken(deviceToken).length === 0, 5000, 'old connection gone');
    await waitUntil(() => !vault.tcpProxy.getPort(ids.echo), 5000, 'listener stopped');

    client = newClient();
    client.connect();
    const t = await waitUntil(allActive, 10000, 'tunnels active after restart');
    assert.deepEqual([t.echo.id, t.web.id, t.ssh.id], [ids.echo, ids.web, ids.ssh]);
    assert.equal(t.echo.allocatedPort, ports.echo);
    assert.equal(t.ssh.allocatedPort, ports.ssh);
    const payload = crypto.randomBytes(512 * 1024);
    assert.equal((await echoThrough(ports.echo, payload)).sha256, sha256(payload));
    const web = await httpRequest({ port: proxyPort, path: '/again', headers: { host: `web.${DOMAIN}` } });
    assert.equal(web.status, 200);
  });

  test('token deletion disconnects the device and removes its tunnels, pins and ports', async () => {
    const r = await api('DELETE', `/api/tokens/${deviceToken}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.disconnected, 1);
    assert.equal(r.json.tunnels_removed, 3);
    await waitUntil(() => vault.registry.connectionsForToken(deviceToken).length === 0, 5000, 'device closed');
    assert.equal(Object.keys(deviceTunnels()).length, 0);
    assert.equal(await probePort(ports.echo), 'ECONNREFUSED');
    const pins = vault.db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key LIKE ?', [`token:${deviceToken}:%`]);
    assert.equal(pins.n, 0);
    const list = await api('GET', '/api/tunnels');
    assert.equal(list.json.tunnels.filter((x) => x.clientToken === deviceToken).length, 0);
    await client.disconnect();
    client = null;
  });
});
