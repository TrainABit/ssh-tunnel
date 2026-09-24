'use strict';

const { TMP_DIR, ADMIN_TOKEN, startVault, request, waitUntil, insertToken } = require('./helpers/platform-env');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('../src/database');
const { createSecretBox } = require('../src/secretBox');
const { readAutoUpdate, readVersion, loadConfig, ConfigError } = require('../src/app');

/** Device connection (protocol v2 header, Bearer auth). */
function connectDevice(vault, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${vault.port}/ws`, {
    headers: { authorization: `Bearer ${token}`, 'x-tunnelvault-protocol': '2' },
  });
  const messages = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(data.toString()));
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    messages,
    closed,
    opened,
    async waitFor(type) {
      return waitUntil(() => messages.find((m) => m.type === type), 5000, `device message ${type}`);
    },
  };
}

describe('createTunnelVault()', () => {
  test('starts on ephemeral ports, serves API/dashboard/proxy, and stops cleanly', async () => {
    const vault = await startVault();
    assert.ok(vault.port > 0);
    assert.ok(vault.proxyPort > 0);
    assert.notEqual(vault.port, vault.proxyPort);
    const health = await request(vault.baseUrl, 'GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    // The HTTP tunnel proxy answers (no tunnel for this host)
    const proxied = await fetch(`http://127.0.0.1:${vault.proxyPort}/`, { headers: { host: 'nothing.test.local' } });
    assert.ok(proxied.status >= 400);
    await proxied.text();

    const t0 = Date.now();
    await vault.stop();
    assert.ok(Date.now() - t0 < 5000, 'stop() should be quick');
    await vault.stop(); // idempotent
    await assert.rejects(fetch(`${vault.baseUrl}/api/health`));
    await assert.rejects(vault.start(), /stopped/);
  });

  test('GET /api/config reports the effective configuration', async () => {
    fs.writeFileSync(process.env.TUNNELVAULT_UPDATE_CONF, 'ENABLED=1\nSCHEDULE="12h"\nUPDATE_REPO=TrainABit/ssh-tunnel\n');
    fs.writeFileSync(process.env.TUNNELVAULT_UPDATE_TIMER, '[Timer]\nOnUnitActiveSec=12h\n');
    const installDir = path.join(TMP_DIR, 'install');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'VERSION'), '2.0.0\n');
    process.env.INSTALL_DIR = installDir;
    const vault = await startVault({
      publicUrl: 'https://tunnel.example.com',
      httpTunnelUrlTemplate: 'https://{subdomain}.tunnel.example.com',
      trustProxy: 'loopback',
      sessionRetentionDays: 14,
      tunnelIdleRetentionDays: 0,
      secretBox: createSecretBox({ key: crypto.randomBytes(32).toString('hex') }),
    });
    try {
      const unauth = await request(vault.baseUrl, 'GET', '/api/config');
      assert.equal(unauth.status, 401);
      const r = await request(vault.baseUrl, 'GET', '/api/config', { bearer: ADMIN_TOKEN });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        version: '2.0.0',
        domain: 'test.local',
        apiPort: vault.port,
        proxyPort: vault.proxyPort,
        tcpPortRange: [vault.tcpProxy.portMin, vault.tcpProxy.portMax],
        publicUrl: 'https://tunnel.example.com',
        httpTunnelUrlTemplate: 'https://{subdomain}.tunnel.example.com',
        trustProxy: true,
        geoipProvider: 'off',
        storedKeysEnabled: true,
        sessionRetentionDays: 14,
        tunnelIdleRetentionDays: 0,
        maxTunnelsPerToken: 10,
        autoUpdate: { enabled: true, paused: false, schedule: '12h' },
      });
      assert.ok(!JSON.stringify(r.body).includes(ADMIN_TOKEN));
      // update.conf is shared with the client updater: without the server's timer the
      // server does not update itself, whatever ENABLED says.
      fs.rmSync(process.env.TUNNELVAULT_UPDATE_TIMER);
      const noTimer = await request(vault.baseUrl, 'GET', '/api/config', { bearer: ADMIN_TOKEN });
      assert.deepEqual(noTimer.body.autoUpdate, { enabled: false, paused: false, schedule: null });
    } finally {
      delete process.env.INSTALL_DIR;
      fs.rmSync(process.env.TUNNELVAULT_UPDATE_CONF, { force: true });
      fs.rmSync(process.env.TUNNELVAULT_UPDATE_TIMER, { force: true });
      await vault.stop();
    }
  });

  test('defaults: template from DOMAIN/proxy port, auto-update disabled when update.conf is absent', async () => {
    const vault = await startVault();
    try {
      const r = await request(vault.baseUrl, 'GET', '/api/config', { bearer: ADMIN_TOKEN });
      assert.equal(r.body.httpTunnelUrlTemplate, `http://{subdomain}.test.local:${vault.proxyPort}`);
      assert.equal(r.body.publicUrl, null);
      assert.equal(r.body.trustProxy, false);
      assert.equal(r.body.storedKeysEnabled, false);
      assert.deepEqual(r.body.autoUpdate, { enabled: false, paused: false, schedule: null });
      assert.equal(r.body.sessionRetentionDays, 90);
      assert.equal(r.body.tunnelIdleRetentionDays, 30);
      assert.match(r.body.version, /^\d+\.\d+\.\d+/);
      // Repo-root VERSION (what release tarballs / installers ship), not package.json.
      assert.equal(r.body.version, fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim());
    } finally {
      await vault.stop();
    }
  });

  test('readAutoUpdate / loadConfig parsing', () => {
    const f = path.join(TMP_DIR, 'u.conf');
    const timer = path.join(TMP_DIR, 'u.timer');
    const missingTimer = path.join(TMP_DIR, 'missing.timer');
    fs.writeFileSync(timer, '[Timer]\n');
    fs.writeFileSync(f, "# comment\nENABLED=0\nSCHEDULE='24h'\n");
    assert.deepEqual(readAutoUpdate(f, timer), { enabled: false, paused: true, schedule: '24h' });
    fs.writeFileSync(f, 'ENABLED=true # yes\n');
    assert.deepEqual(readAutoUpdate(f, timer), { enabled: true, paused: false, schedule: null });
    // Exactly what install-server.sh / install-client.sh render (unquoted values, empty PINNED_VERSION).
    fs.writeFileSync(f, '# TunnelVault auto-update settings\nENABLED=1\nSCHEDULE=12h\nUPDATE_REPO=TrainABit/ssh-tunnel\n'
      + 'PINNED_VERSION=\nPUBKEY=/etc/tunnelvault/release-signing.pub\n');
    assert.deepEqual(readAutoUpdate(f, timer), { enabled: true, paused: false, schedule: '12h' });
    // Same file written by install-client.sh on a device-only host (or seen from a container):
    // the server has no updater timer, so its auto-update is not enabled.
    assert.deepEqual(readAutoUpdate(f, missingTimer), { enabled: false, paused: false, schedule: null });
    assert.deepEqual(readAutoUpdate(f, TMP_DIR), { enabled: false, paused: false, schedule: null }, 'a directory is not the timer');
    for (const [value, enabled] of [['yes', true], ['on', true], ['"1"', true], ['TRUE', true], ['0', false],
      ['no', false], ['off', false], ['', false], ['"0"', false]]) {
      fs.writeFileSync(f, `ENABLED=${value}\r\nSCHEDULE="6h"\r\n`);
      assert.deepEqual(readAutoUpdate(f, timer), { enabled, paused: !enabled, schedule: '6h' }, `ENABLED=${value}`);
    }
    // Timer installed but no update.conf: the updater treats that as ENABLED=0 (paused).
    assert.deepEqual(readAutoUpdate(path.join(TMP_DIR, 'missing.conf'), timer), { enabled: false, paused: true, schedule: null });
    assert.deepEqual(readAutoUpdate(path.join(TMP_DIR, 'missing.conf'), missingTimer), { enabled: false, paused: false, schedule: null });
    assert.equal(loadConfig({}).updateTimerPath, '/etc/systemd/system/tunnelvault-autoupdate.timer');
    assert.equal(loadConfig({ TUNNELVAULT_UPDATE_TIMER: timer }).updateTimerPath, timer);
    // INSTALL_DIR/VERSION wins over the repo-root VERSION; junk is ignored.
    const installDir = fs.mkdtempSync(path.join(TMP_DIR, 'install-'));
    fs.writeFileSync(path.join(installDir, 'VERSION'), '2.3.4\n');
    assert.equal(readVersion(installDir), '2.3.4');
    fs.writeFileSync(path.join(installDir, 'VERSION'), '<script>\n');
    assert.equal(readVersion(installDir), fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim());
    const cfg = loadConfig({ PORT: '0', PROXY_PORT: '8081', BIND_HOST: '127.0.0.1', TRUST_PROXY: '10.0.0.0/8' });
    assert.equal(cfg.port, 0);
    assert.equal(cfg.proxyPort, 8081);
    assert.equal(cfg.bindHost, '127.0.0.1');
    assert.deepEqual(cfg.trustProxy, ['10.0.0.0/8']);
    assert.equal(loadConfig({}).port, 4000);
    assert.equal(loadConfig({}).bindHost, '0.0.0.0');
    assert.equal(loadConfig({}).trustProxy, false);
    assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ PROXY_PORT: '70000' }), ConfigError);
  });

  test('startup: encrypts plaintext stored keys and closes dangling tunnel sessions', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
    const token = insertToken(db, { privateKey: pem });
    const s = db.run("INSERT INTO sessions (token, client_ip, tunnel_id) VALUES (?, '203.0.113.9', 'tid')", [token]);
    const box = createSecretBox({ key: crypto.randomBytes(32).toString('hex') });
    const vault = await startVault({ secretBox: box });
    try {
      const stored = db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key;
      assert.ok(stored.startsWith('tvenc:v1:'));
      assert.equal(box.decrypt(stored), pem);
      assert.ok(db.queryOne('SELECT disconnected_at FROM sessions WHERE id = ?', [Number(s.lastInsertRowid)]).disconnected_at);
    } finally {
      await vault.stop();
    }
  });
});

/**
 * Raw upgrade request; resolves { data, closed, ms } once the server closes the
 * socket, or { closed: false } after waitMs.
 */
function rawUpgrade(port, target, waitMs = 2000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ data, closed: false, ms: Date.now() - t0 });
    }, waitMs);
    sock.on('connect', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    sock.on('data', (d) => { data += d.toString('latin1'); });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      resolve({ data, closed: true, ms: Date.now() - t0 });
    });
  });
}

describe('upgrade requests outside /ws and /ws/ssh', () => {
  test('are answered 404 and closed at once (no unauthenticated socket parking)', async () => {
    const vault = await startVault();
    try {
      for (const target of ['/nope', '/api/health', '/ws/other', '/wss', '/ws/ssh/x', '//']) {
        const r = await rawUpgrade(vault.port, target);
        assert.ok(r.closed, `${target}: socket still open after 2 s`);
        assert.match(r.data, /^HTTP\/1\.1 404 /, `${target}: ${JSON.stringify(r.data.slice(0, 80))}`);
      }
      // Many at once: none of them is kept by the server
      const burst = await Promise.all(Array.from({ length: 20 }, () => rawUpgrade(vault.port, '/x')));
      assert.ok(burst.every((r) => r.closed && r.data.startsWith('HTTP/1.1 404')));
      // /ws and /ws/ssh are still handled by their own endpoints
      const ws = await rawUpgrade(vault.port, '/ws');
      assert.match(ws.data, /^HTTP\/1\.1 401 /);
      const ssh = await rawUpgrade(vault.port, '/ws/ssh?tunnelId=x');
      assert.match(ssh.data, /^HTTP\/1\.1 401 /);
      const dev = connectDevice(vault, ADMIN_TOKEN);
      await dev.opened;
      await dev.waitFor('hello');
      dev.ws.close();
      await dev.closed;
      // Plain requests are unaffected
      assert.equal((await request(vault.baseUrl, 'GET', '/api/health')).status, 200);
    } finally {
      await vault.stop();
    }
  });
});

describe('token revocation through the API (live device connections)', () => {
  test('PATCH active=0 closes the device WebSocket with 4000 within 5 s; public port closes', async () => {
    const vault = await startVault();
    try {
      const token = insertToken(db);
      const dev = connectDevice(vault, token);
      await dev.opened;
      await dev.waitFor('hello');
      dev.ws.send(JSON.stringify({ type: 'register', name: 'ssh', localPort: 22, subdomain: 'ssh', protocol: 'tcp' }));
      const reg = await dev.waitFor('registered');
      assert.ok(reg.allocatedPort > 0);
      await new Promise((resolve, reject) => {
        const s = net.connect(reg.allocatedPort, '127.0.0.1', () => { s.destroy(); resolve(); });
        s.on('error', reject);
      });

      const t0 = Date.now();
      const r = await request(vault.baseUrl, 'PATCH', `/api/tokens/${token}`, { bearer: ADMIN_TOKEN, body: { active: 0 } });
      assert.equal(r.status, 200);
      assert.equal(r.body.disconnected, 1);
      const code = await Promise.race([dev.closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
      assert.equal(code, 4000);
      assert.ok(Date.now() - t0 < 5000);

      await waitUntil(() => new Promise((resolve) => {
        const s = net.connect(reg.allocatedPort, '127.0.0.1');
        s.on('connect', () => { s.destroy(); resolve(false); });
        s.on('error', () => resolve(true));
      }), 5000, 'public TCP port to close');

      // A deactivated token cannot reconnect
      const again = new WebSocket(`ws://127.0.0.1:${vault.port}/ws`, { headers: { authorization: `Bearer ${token}` } });
      const status = await new Promise((resolve) => {
        again.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); });
        again.on('open', () => resolve(101));
        again.on('error', () => {});
      });
      assert.equal(status, 401);
    } finally {
      await vault.stop();
    }
  });

  test('DELETE closes the connection, removes its tunnels and pins', async () => {
    const vault = await startVault();
    try {
      const token = insertToken(db);
      const dev = connectDevice(vault, token);
      await dev.opened;
      await dev.waitFor('hello');
      dev.ws.send(JSON.stringify({ type: 'register', name: 'ssh', localPort: 22, subdomain: 'ssh', protocol: 'tcp' }));
      const reg = await dev.waitFor('registered');
      db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?)', [`token:${token}:22`, 'ssh-ed25519', 'SHA256:x']);
      assert.ok(vault.tunnelManager.getTunnel(reg.tunnelId));

      const r = await request(vault.baseUrl, 'DELETE', `/api/tokens/${token}`, { bearer: ADMIN_TOKEN });
      assert.equal(r.status, 200);
      assert.equal(r.body.disconnected, 1);
      assert.equal(r.body.tunnels_removed, 1);
      const code = await Promise.race([dev.closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]);
      assert.equal(code, 4000);
      assert.equal(vault.tunnelManager.getTunnel(reg.tunnelId), null);
      assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM tunnels WHERE client_token = ?', [token]).n, 0);
      assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key = ?', [`token:${token}:22`]).n, 0);
      const list = await request(vault.baseUrl, 'GET', '/api/tunnels', { bearer: ADMIN_TOKEN });
      assert.ok(!list.body.tunnels.some((t) => t.id === reg.tunnelId));
    } finally {
      await vault.stop();
    }
  });
});

describe('server.js entrypoint: configuration errors exit 78 (systemd RestartPreventExitStatus=78)', () => {
  const { spawn } = require('child_process');
  const SERVER_JS = path.join(__dirname, '..', 'src', 'server.js');

  /** Run server.js in a clean cwd (no .env) with the given env; resolves { code, output }. */
  function runServer(extraEnv) {
    const cwd = fs.mkdtempSync(path.join(TMP_DIR, 'srv-'));
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      AUTH_TOKEN: ADMIN_TOKEN,
      DB_PATH: path.join(cwd, 'tunnelvault.db'),
      PORT: '0',
      PROXY_PORT: '0',
      BIND_HOST: '127.0.0.1',
      TUNNELVAULT_UPDATE_CONF: path.join(cwd, 'update.conf'),
      ...extraEnv,
    };
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER_JS], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server.js did not exit: ${output}`)); }, 15000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
  }

  test('unreadable TLS_PROXY_CERT/TLS_PROXY_KEY (HTTP proxy) -> exit 78 with an actionable message', async () => {
    const r = await runServer({ TLS_PROXY_CERT: '/nonexistent/proxy-cert.pem', TLS_PROXY_KEY: '/nonexistent/proxy-key.pem' });
    assert.equal(r.code, 78, r.output);
    assert.match(r.output, /proxy-cert\.pem|TLS/);
    assert.doesNotMatch(r.output, /^\s+at /m, 'no stack trace');
    assert.ok(!r.output.includes(ADMIN_TOKEN), 'no secrets in the log');
  });

  test('unreadable TLS_CERT/TLS_KEY and missing AUTH_TOKEN in production -> exit 78', async () => {
    const tls = await runServer({ TLS_CERT: '/nonexistent/fullchain.pem', TLS_KEY: '/nonexistent/privkey.pem' });
    assert.equal(tls.code, 78, tls.output);
    assert.match(tls.output, /TLS_CERT/);
    const noToken = await runServer({ AUTH_TOKEN: '' });
    assert.equal(noToken.code, 78, noToken.output);
    assert.match(noToken.output, /AUTH_TOKEN/);
  });
});
