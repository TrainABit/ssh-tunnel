'use strict';

const { ADMIN_TOKEN, startVault, request, cookiePair, waitUntil, insertToken } = require('./helpers/platform-env');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const db = require('../src/database');
const { createSecretBox } = require('../src/secretBox');
const { fingerprintOf } = require('../src/sshWsHandler');
const { FakeDevice } = require('./helpers/core-device');
const { generateKeyPair } = require('./helpers/ssh-keys');

// generateKeyPair = ssh2 keygen retried until the key parses (ssh2 emits malformed keys ~0.4% of the time).
const HOST_KEY = generateKeyPair('ed25519');
const OTHER_HOST_KEY = generateKeyPair('ed25519');
const USER_KEY = generateKeyPair('ed25519');
const ALLOWED_PUB = sshUtils.parseKey(USER_KEY.public);
const HOST_FP = fingerprintOf(sshUtils.parseKey(HOST_KEY.public).getPublicSSH());
const UTF8_TEXT = 'äöü ✓ 🚀 ok\r\n';

/**
 * Minimal SSH server: password alice/secret, publickey keyuser/USER_KEY.
 * The shell writes UTF8_TEXT split inside multi-byte sequences and records input.
 */
function startSshServer(hostKey) {
  const state = { input: [], resizes: [], pty: null, streams: new Set() };
  const server = new SshServer({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'alice' && ctx.password === 'secret') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.username === 'keyuser'
          && ctx.key.algo === ALLOWED_PUB.type && ctx.key.data.equals(ALLOWED_PUB.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (ALLOWED_PUB.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, _reject, info) => {
          state.pty = info;
          if (acceptPty) acceptPty();
        });
        session.on('window-change', (acceptWc, _reject, info) => {
          state.resizes.push({ cols: info.cols, rows: info.rows });
          if (acceptWc) acceptWc();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          state.streams.add(stream);
          stream.on('close', () => state.streams.delete(stream));
          stream.on('data', (d) => state.input.push(Buffer.from(d)));
          const bytes = Buffer.from(UTF8_TEXT, 'utf8');
          // Cut inside 'ä' (2 bytes), '✓' (3 bytes) and '🚀' (4 bytes)
          const cuts = [1, 5, 10, 14, bytes.length];
          let prev = 0;
          let delay = 0;
          for (const cut of cuts) {
            const chunk = bytes.subarray(prev, cut);
            prev = cut;
            delay += 15;
            setTimeout(() => { if (stream.writable) stream.write(chunk); }, delay);
          }
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

const devices = new Set();

/**
 * Connect a (protocol v2) device to the vault and register a TCP tunnel to the
 * test SSH server listening on `port`. The web terminal reaches the SSH server
 * through this device (tcp-open over its WebSocket). Returns the tunnel id.
 */
async function registerTunnel(vault, port, clientToken = null) {
  const device = new FakeDevice({ url: `ws://127.0.0.1:${vault.port}/ws`, token: clientToken || ADMIN_TOKEN });
  devices.add(device);
  await device.connect();
  const reg = await device.register({ localPort: port, protocol: 'tcp' });
  assert.equal(reg.type, 'registered', JSON.stringify(reg));
  return reg.tunnelId;
}

async function closeDevices() {
  for (const d of devices) await d.terminate().catch(() => {});
  devices.clear();
}

function openTerminal(vault, tunnelId, { cookie, bearer, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const opts = { headers };
  if (origin !== null) opts.origin = origin || `http://127.0.0.1:${vault.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${vault.port}/ws/ssh?tunnelId=${encodeURIComponent(tunnelId)}`, opts);
  const messages = [];
  const frames = [];
  let textFrames = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) frames.push(Buffer.from(data));
    else {
      textFrames++;
      messages.push(JSON.parse(data.toString('utf8')));
    }
  });
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      res.resume();
    });
    ws.on('error', reject);
  });
  opened.catch(() => {});
  return {
    ws,
    messages,
    frames,
    closed,
    opened,
    get textFrames() { return textFrames; },
    async waitFor(type, timeoutMs = 5000) {
      return waitUntil(() => {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return messages.splice(i, 1)[0];
        const err = type !== 'error' && messages.find((m) => m.type === 'error' || m.type === 'hostkey-mismatch');
        if (err) throw new Error(`Got ${JSON.stringify(err)} while waiting for ${type}`);
        return null;
      }, timeoutMs, `terminal message ${type}`);
    },
    sendJson(obj) { ws.send(JSON.stringify(obj)); },
  };
}

describe('web SSH terminal (/ws/ssh)', () => {
  let vault;
  let ssh;
  let cookie;
  let origin;
  const box = createSecretBox({ key: crypto.randomBytes(32).toString('hex') });

  before(async () => {
    vault = await startVault({
      secretBox: box,
      apiRateLimitPerMin: 10_000,
      sshOptions: { rateLimitPerMin: 1000, hostKeyTimeoutMs: 1500 },
    });
    ssh = await startSshServer(HOST_KEY);
    origin = `http://127.0.0.1:${vault.port}`;
    const login = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: ADMIN_TOKEN } });
    cookie = cookiePair(login.setCookie[0]);
  });
  after(async () => {
    for (const s of ssh.state.streams) s.close();
    await closeDevices();
    await new Promise((r) => ssh.server.close(r));
    await vault.stop();
  });

  test('upgrade requires a session cookie (or Bearer) and the same Origin; no query tokens', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    const anon = openTerminal(vault, tunnelId);
    await assert.rejects(anon.opened, (e) => e.status === 401);
    const queryToken = new WebSocket(`ws://127.0.0.1:${vault.port}/ws/ssh?tunnelId=${tunnelId}&auth_token=${ADMIN_TOKEN}`);
    const status = await new Promise((resolve) => {
      queryToken.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); });
      queryToken.on('open', () => resolve(101));
      queryToken.on('error', () => {});
    });
    assert.equal(status, 401);
    const cross = openTerminal(vault, tunnelId, { cookie, origin: 'http://evil.example' });
    await assert.rejects(cross.opened, (e) => e.status === 403);
    const sameSite = openTerminal(vault, tunnelId, { cookie, origin: 'http://tunnel.test.local' });
    await assert.rejects(sameSite.opened, (e) => e.status === 403);

    const viaCookie = openTerminal(vault, tunnelId, { cookie });
    await viaCookie.opened;
    await viaCookie.waitFor('ready');
    viaCookie.ws.close();
    const viaBearer = openTerminal(vault, tunnelId, { bearer: ADMIN_TOKEN, origin: null });
    await viaBearer.opened;
    await viaBearer.waitFor('ready');
    viaBearer.ws.close();
    await Promise.all([viaCookie.closed, viaBearer.closed]);
  });

  test('unknown tunnel / inactive tunnel are refused', async () => {
    const t = openTerminal(vault, 'nope', { cookie });
    await t.opened;
    const err = await t.waitFor('error');
    assert.equal(err.message, 'Tunnel not found');
    assert.equal((await t.closed).code, 1008);
  });

  test('TOFU: unknown host key -> accept -> pinned; UTF-8 output is byte-exact in binary frames', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    ssh.state.input.length = 0;
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'alice', password: 'secret', cols: 100, rows: 30 });
    const unknown = await t.waitFor('hostkey-unknown');
    assert.equal(unknown.fingerprint, HOST_FP);
    assert.equal(unknown.keyType, 'ssh-ed25519');
    assert.match(unknown.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnelId}`]).n, 0);
    t.sendJson({ type: 'hostkey-accept' });
    await t.waitFor('connected');

    const pin = db.queryOne('SELECT * FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnelId}`]);
    assert.equal(pin.fingerprint, HOST_FP);
    assert.equal(pin.key_type, 'ssh-ed25519');
    assert.deepEqual({ cols: ssh.state.pty.cols, rows: ssh.state.pty.rows }, { cols: 100, rows: 30 });

    const expected = Buffer.from(UTF8_TEXT, 'utf8');
    await waitUntil(() => Buffer.concat(t.frames).length >= expected.length, 5000, 'terminal output');
    assert.deepEqual(Buffer.concat(t.frames), expected);
    assert.equal(Buffer.concat(t.frames).toString('utf8'), UTF8_TEXT);
    assert.ok(t.frames.length >= 2, 'output should arrive in several binary frames');

    // Keystrokes: binary UTF-8 frames reach the shell byte-exact
    const typed = Buffer.from('ü✓🚀\n', 'utf8');
    t.ws.send(typed.subarray(0, 3));
    t.ws.send(typed.subarray(3));
    await waitUntil(() => Buffer.concat(ssh.state.input).length >= typed.length, 5000, 'shell input');
    assert.deepEqual(Buffer.concat(ssh.state.input), typed);

    // Resize: validated, forwarded as window-change
    t.sendJson({ type: 'resize', cols: 0, rows: 10 });
    t.sendJson({ type: 'resize', cols: 5000, rows: 10 });
    t.sendJson({ type: 'resize', cols: 132, rows: 43 });
    await waitUntil(() => ssh.state.resizes.length >= 1, 5000, 'window-change');
    assert.deepEqual(ssh.state.resizes, [{ cols: 132, rows: 43 }]);

    // The pin shows up in the API
    const list = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
    const row = list.body.tunnels.find((x) => x.id === tunnelId);
    assert.equal(row.host_key_fingerprint, HOST_FP);
    assert.equal(row.has_private_key, false);

    t.ws.close();
    await t.closed;

    // Second session: pinned key matches -> no prompt
    const t2 = openTerminal(vault, tunnelId, { cookie });
    await t2.opened;
    await t2.waitFor('ready');
    t2.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
    await t2.waitFor('connected');
    assert.ok(!t2.messages.some((m) => m.type === 'hostkey-unknown'));
    t2.ws.close();
    await t2.closed;
  });

  test('pinned key mismatch is refused with hostkey-mismatch and close 1008', async () => {
    const other = await startSshServer(OTHER_HOST_KEY);
    try {
      const tunnelId = await registerTunnel(vault, other.port);
      db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?)',
        [`tunnel:${tunnelId}`, 'ssh-ed25519', HOST_FP]);
      const t = openTerminal(vault, tunnelId, { cookie });
      await t.opened;
      await t.waitFor('ready');
      t.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
      const mm = await t.waitFor('hostkey-mismatch');
      assert.equal(mm.expected, HOST_FP);
      assert.equal(mm.actual, fingerprintOf(sshUtils.parseKey(OTHER_HOST_KEY.public).getPublicSSH()));
      assert.equal(mm.keyType, 'ssh-ed25519');
      const c = await t.closed;
      assert.equal(c.code, 1008);
      assert.ok(!t.messages.some((m) => m.type === 'connected'));
      assert.equal(other.state.streams.size, 0);
      // Pin unchanged
      assert.equal(db.queryOne('SELECT fingerprint FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnelId}`]).fingerprint, HOST_FP);

      // Forgetting the pin via the API allows a fresh TOFU prompt
      const del = await request(vault.baseUrl, 'DELETE', `/api/tunnels/${tunnelId}/hostkey`, { cookie, headers: { origin } });
      assert.equal(del.status, 200);
      assert.equal(del.body.removed, true);
      const t2 = openTerminal(vault, tunnelId, { cookie });
      await t2.opened;
      await t2.waitFor('ready');
      t2.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
      await t2.waitFor('hostkey-unknown');
      t2.sendJson({ type: 'hostkey-reject' });
      const err = await t2.waitFor('error');
      assert.equal(err.message, 'Host key rejected');
      assert.equal((await t2.closed).code, 1008);
      assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnelId}`]).n, 0);
    } finally {
      for (const s of other.state.streams) s.close();
      await new Promise((r) => other.server.close(r));
    }
  });

  test('SSH runs over the device WebSocket (tcpProxy.openStream), not the public TCP listener', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    // Without its public listener the tunnel is still usable from the web terminal
    // (works with any TCP_BIND_HOST and records no 127.0.0.1 sessions rows).
    assert.equal(vault.tcpProxy.stopListener(tunnelId), true);
    const bytesBefore = vault.tunnelManager.getTunnel(tunnelId).bytesTransferred;
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
    await t.waitFor('hostkey-unknown');
    t.sendJson({ type: 'hostkey-accept' });
    await t.waitFor('connected');
    const expected = Buffer.from(UTF8_TEXT, 'utf8');
    await waitUntil(() => Buffer.concat(t.frames).length >= expected.length, 5000, 'terminal output');
    assert.deepEqual(Buffer.concat(t.frames), expected);

    // Listed as a live connection of the tunnel (browser IP), traffic counted, no sessions row.
    const live = vault.connectionTracker.getConnections(tunnelId);
    assert.equal(live.length, 1);
    assert.match(live[0].sourceIp, /127\.0\.0\.1/);
    await waitUntil(() => vault.tunnelManager.getTunnel(tunnelId).bytesTransferred > bytesBefore, 5000, 'traffic accounting');
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM sessions WHERE tunnel_id = ?', [tunnelId]).n, 0);
    assert.equal(vault.tcpProxy.getPort(tunnelId), null, 'public listener stays stopped');

    t.ws.close();
    await t.closed;
    await waitUntil(() => vault.connectionTracker.getConnections(tunnelId).length === 0, 5000, 'live connection removed');
    // The tunnel stream to the device is released as well.
    const channel = vault.tunnelManager.getTunnel(tunnelId).clientWs.tunnelChannel;
    await waitUntil(() => channel.streams.size === 0, 7000, 'tunnel stream released');
  });

  test('large paste: 6 MiB in 64 KiB frames reaches a slow SSH shell byte-exact (input backpressure)', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    const earlierShells = new Set(ssh.state.streams);
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
    await t.waitFor('hostkey-unknown');
    t.sendJson({ type: 'hostkey-accept' });
    await t.waitFor('connected');
    const shell = await waitUntil(() => [...ssh.state.streams].find((x) => !earlierShells.has(x)), 5000, 'shell stream');
    ssh.state.input.length = 0;
    shell.pause(); // the SSH side stops reading: the SSH window fills up

    const paste = crypto.randomBytes(6 * 1024 * 1024); // > SSH window (2 MiB) + channel buffer (2 MiB)
    for (let off = 0; off < paste.length; off += 64 * 1024) t.ws.send(paste.subarray(off, off + 64 * 1024));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(Buffer.concat(ssh.state.input).length < paste.length, 'shell paused');
    shell.resume();
    await waitUntil(() => Buffer.concat(ssh.state.input).length >= paste.length, 10000, 'paste delivered');
    assert.ok(Buffer.concat(ssh.state.input).equals(paste), 'paste byte-exact');
    assert.equal(t.ws.readyState, WebSocket.OPEN);
    t.ws.close();
    await t.closed;
  });

  test('device going offline ends the terminal session; offline tunnels are refused', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    const device = [...devices].pop();
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
    await t.waitFor('hostkey-unknown');
    t.sendJson({ type: 'hostkey-accept' });
    await t.waitFor('connected');

    await device.terminate();
    const closed = await t.closed;
    assert.ok([1000, 1011].includes(closed.code), `close code ${closed.code}`);
    assert.ok(t.messages.some((m) => m.type === 'disconnected' || m.type === 'error'));
    await waitUntil(() => vault.tunnelManager.getTunnel(tunnelId).status === 'inactive', 5000, 'tunnel inactive');

    const again = openTerminal(vault, tunnelId, { cookie });
    await again.opened;
    assert.equal((await again.waitFor('error')).message, 'Tunnel is not active');
    assert.equal((await again.closed).code, 1008);
  });

  test('host key prompt times out (reject)', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port);
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'alice', password: 'secret' });
    await t.waitFor('hostkey-unknown');
    const err = await t.waitFor('error', 5000);
    assert.equal(err.message, 'Host key confirmation timed out');
    assert.equal((await t.closed).code, 1008);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key = ?', [`tunnel:${tunnelId}`]).n, 0);
  });

  test('stored (encrypted) private key authentication; pin scoped to token + local port', async () => {
    const token = insertToken(db);
    const patch = await request(vault.baseUrl, 'PATCH', `/api/tokens/${token}`, {
      cookie, headers: { origin }, body: { private_key: USER_KEY.private },
    });
    assert.equal(patch.status, 200);
    assert.ok(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key.startsWith('tvenc:v1:'));
    const tunnelId = await registerTunnel(vault, ssh.port, token);

    const list = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
    assert.equal(list.body.tunnels.find((x) => x.id === tunnelId).has_private_key, true);
    assert.ok(!JSON.stringify(list.body).includes('BEGIN'));

    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'keyuser', useStoredKey: true });
    await t.waitFor('hostkey-unknown');
    t.sendJson({ type: 'hostkey-accept' });
    await t.waitFor('connected');
    assert.equal(db.queryOne('SELECT fingerprint FROM ssh_host_keys WHERE pin_key = ?', [`token:${token}:${ssh.port}`]).fingerprint, HOST_FP);
    t.ws.close();
    await t.closed;

    // Wrong password -> SSH auth error, socket closed
    const bad = openTerminal(vault, tunnelId, { cookie });
    await bad.opened;
    await bad.waitFor('ready');
    bad.sendJson({ type: 'credentials', username: 'alice', password: 'wrong' });
    const err = await bad.waitFor('error');
    assert.match(err.message, /SSH error/);
    await bad.closed;
  });

  test('stored key refused when the owner has none; invalid credentials messages', async () => {
    const tunnelId = await registerTunnel(vault, ssh.port, insertToken(db));
    const t = openTerminal(vault, tunnelId, { cookie });
    await t.opened;
    await t.waitFor('ready');
    t.sendJson({ type: 'credentials', username: 'keyuser', useStoredKey: true });
    assert.equal((await t.waitFor('error')).message, 'No stored SSH key found for this tunnel');
    assert.equal((await t.closed).code, 1008);

    const big = openTerminal(vault, tunnelId, { cookie });
    await big.opened;
    await big.waitFor('ready');
    big.sendJson({ type: 'credentials', username: 'alice', password: 'x'.repeat(70 * 1024) });
    assert.equal((await big.waitFor('error')).message, 'Message too large');
    assert.equal((await big.closed).code, 1009);

    const badUser = openTerminal(vault, tunnelId, { cookie });
    await badUser.opened;
    await badUser.waitFor('ready');
    badUser.sendJson({ type: 'credentials', username: 'a b\n', password: 'x' });
    assert.equal((await badUser.waitFor('error')).message, 'Invalid username');
    await badUser.closed;
  });

  test('session slots are released exactly once', async () => {
    await waitUntil(() => vault.sshApi.activeSessions === 0, 5000, 'all web terminal sessions released');
    assert.equal(vault.sshApi.activeSessions, 0);
  });
});

describe('web SSH terminal without DATA_ENCRYPTION_KEY', () => {
  test('useStoredKey is refused with a clear error', async () => {
    const vault = await startVault({ secretBox: createSecretBox({}), sshOptions: { rateLimitPerMin: 1000 } });
    const ssh = await startSshServer(HOST_KEY);
    try {
      const tunnelId = await registerTunnel(vault, ssh.port, insertToken(db));
      const t = openTerminal(vault, tunnelId, { bearer: ADMIN_TOKEN, origin: null });
      await t.opened;
      await t.waitFor('ready');
      t.sendJson({ type: 'credentials', username: 'keyuser', useStoredKey: true });
      assert.match((await t.waitFor('error')).message, /DATA_ENCRYPTION_KEY/);
      await t.closed;
    } finally {
      await closeDevices();
      await new Promise((r) => ssh.server.close(r));
      await vault.stop();
    }
  });

  test('per-IP upgrade rate limit -> 429', async () => {
    const vault = await startVault({ sshOptions: { rateLimitPerMin: 2 } });
    try {
      const tunnelId = 'x';
      const results = [];
      for (let i = 0; i < 3; i++) {
        const t = openTerminal(vault, tunnelId, { bearer: ADMIN_TOKEN, origin: null });
        try {
          await t.opened;
          results.push(101);
          t.ws.close();
          await t.closed;
        } catch (e) {
          results.push(e.status);
        }
      }
      assert.deepEqual(results, [101, 101, 429]);
    } finally {
      await vault.stop();
    }
  });
});
