'use strict';

// Control plane: revocation (registry + heartbeat), per-token limits,
// connection cap (4003), upgrade auth + rate limiting, tunnel cleanup and
// batched stats.
const { startHarness, listen, closeServer, waitUntil, db: realDb } = require('./helpers/core-harness');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const { once } = require('events');
const TunnelManager = require('../src/tunnelManager');
const { createMaintenance } = require('../src/maintenance');
const { FakeDevice } = require('./helpers/core-device');

const DAY_MS = 86400_000;
/** SQLite datetime format (created_at default). */
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

let echoServer;
let echoPort;

before(async () => {
  echoServer = net.createServer((s) => s.pipe(s));
  echoPort = await listen(echoServer);
});

after(async () => {
  await closeServer(echoServer);
});

function connectRefused(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
}

/** Open a public TCP connection and do one echo round trip; returns the open socket. */
async function openEcho(port) {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {});
  await once(s, 'connect');
  s.write('ping');
  await once(s, 'data');
  return s;
}

function makeDeviceFactory(getHarness, list) {
  return async function device(opts = {}) {
    const h = getHarness();
    const d = new FakeDevice({ url: h.wsUrl, token: h.authToken, ...opts });
    list.push(d);
    await d.connect();
    return d;
  };
}

describe('revocation, limits and connection cap', () => {
  let h;
  const devices = [];
  const device = makeDeviceFactory(() => h, devices);

  before(async () => {
    h = await startHarness({
      heartbeatMs: 200,
      maxTunnelsPerToken: 3,
      maxConnectionsPerToken: 2,
      statsFlushMs: 250,
    });
  });

  after(async () => {
    for (const d of devices) await d.terminate().catch(() => {});
    await h.close();
  });

  test('registry.disconnectToken closes the device within 5 s and stops its public listener', async () => {
    const token = h.createToken('revoke-me');
    const d = await device({ token });
    const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
    const pub = await openEcho(reg.allocatedPort);
    const pubClosed = once(pub, 'close');

    const t0 = Date.now();
    h.db.run('UPDATE tokens SET active = 0 WHERE token = ?', [token]);
    assert.equal(h.registry.disconnectToken(token), 1);
    const { code, reason } = await d.closed;
    assert.equal(code, 4000);
    assert.equal(reason, 'Token revoked');
    await waitUntil(() => !h.tcpProxy.servers.has(reg.tunnelId), 5000, 'listener stop');
    await pubClosed;
    assert.ok(Date.now() - t0 < 5000, 'closed within 5 s');
    assert.equal(await connectRefused(reg.allocatedPort), true, 'public TCP port closed');
    assert.equal(h.registry.connectionsForToken(token).length, 0);
    assert.equal(h.tunnelManager.getTunnel(reg.tunnelId).status, 'inactive');

    // The revoked token cannot come back.
    await assert.rejects(device({ token }), (err) => err.statusCode === 401);
    assert.equal(h.registry.disconnectToken(token), 0);
  });

  test('disconnectToken terminates a device that ignores the close frame (within 5 s)', async () => {
    const token = h.createToken('stubborn');
    const d = await device({ token });
    const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
    const serverWs = h.tunnelManager.getTunnel(reg.tunnelId).clientWs;
    d.ws._socket.pause(); // never reads (so never answers) the close frame

    const t0 = Date.now();
    h.registry.disconnectToken(token);
    // New public connections are refused immediately, the port is released at the latest on terminate().
    await waitUntil(() => serverWs.readyState === 3, 5000, 'server-side socket closed');
    await waitUntil(() => !h.tcpProxy.servers.has(reg.tunnelId), 5000, 'listener stop');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `terminated after ${elapsed} ms`);
    assert.equal(await connectRefused(reg.allocatedPort), true);
    d.ws._socket.resume();
  });

  test('heartbeat re-validates device tokens (deactivated or deleted -> 4000)', async () => {
    const deactivated = h.createToken('hb-deactivated');
    const deleted = h.createToken('hb-deleted');
    const keep = h.createToken('hb-keep');
    const d1 = await device({ token: deactivated });
    const d2 = await device({ token: deleted });
    const d3 = await device({ token: keep });
    const admin = await device();
    const reg = await d1.register({ localPort: echoPort, protocol: 'tcp' });

    h.db.run('UPDATE tokens SET active = 0 WHERE token = ?', [deactivated]);
    h.db.run('DELETE FROM tokens WHERE token = ?', [deleted]);
    const [c1, c2] = await Promise.all([d1.closed, d2.closed]);
    assert.equal(c1.code, 4000);
    assert.equal(c2.code, 4000);
    await waitUntil(() => !h.tcpProxy.servers.has(reg.tunnelId), 3000, 'listener stop');

    // Unaffected connections survive several heartbeats.
    await new Promise(r => setTimeout(r, 600));
    assert.equal(d3.ws.readyState, 1);
    assert.equal(admin.ws.readyState, 1);
    await Promise.all([d3.close(), admin.close()]);
  });

  test('heartbeat terminates peers that stop answering pings', async () => {
    const token = h.createToken('silent');
    const d = await device({ token });
    const [serverWs] = h.registry.connectionsForToken(token);
    d.ws._socket.pause();
    await waitUntil(() => serverWs.readyState === 3, 3000, 'dead peer terminated');
    assert.equal(h.registry.connectionsForToken(token).length, 0);
    d.ws._socket.resume();
  });

  test('device pings count as liveness even when server pings go unanswered', async () => {
    // A server ping can sit behind megabytes of queued data on a slow link, so the
    // device's own 15 s pings must keep it alive. autoPong:false = never answer ours.
    const WebSocket = require('ws');
    const token = h.createToken('pinger');
    const ws = new WebSocket(h.wsUrl, {
      headers: { Authorization: `Bearer ${token}`, 'X-TunnelVault-Protocol': '2' },
      autoPong: false,
      perMessageDeflate: false,
    });
    ws.on('error', () => {});
    await once(ws, 'open');
    let serverPings = 0;
    ws.on('ping', () => { serverPings++; });
    const closed = once(ws, 'close');
    const pinger = setInterval(() => { try { ws.ping(); } catch {} }, 50);
    try {
      await new Promise(r => setTimeout(r, 1000)); // ~5 heartbeat rounds of 200 ms
      assert.ok(serverPings >= 3, `server pinged ${serverPings} times`);
      assert.equal(ws.readyState, WebSocket.OPEN, 'device that pings stays connected');
      assert.equal(h.registry.connectionsForToken(token).length, 1);
    } finally {
      clearInterval(pinger);
    }
    // Negative control: without its own pings (and still ignoring ours) it is dropped.
    await waitUntil(() => ws.readyState === WebSocket.CLOSED, 3000, 'silent peer terminated');
    await closed;
    await waitUntil(() => h.registry.connectionsForToken(token).length === 0, 3000, 'registry cleanup');
  });

  test('per-token tunnel limit is counted across all connections of the token', async () => {
    const token = h.createToken('limited');
    const d1 = await device({ token });
    const d2 = await device({ token });
    const a = await d1.register({ localPort: 40001, protocol: 'tcp' });
    const b = await d1.register({ localPort: 40002, protocol: 'http', subdomain: 'lim-b' });
    const c = await d2.register({ localPort: 40003, protocol: 'tcp' });
    assert.deepEqual([a.type, b.type, c.type], ['registered', 'registered', 'registered']);

    const over = await d2.register({ localPort: 40004, protocol: 'tcp' });
    assert.equal(over.type, 'error');
    assert.equal(over.code, 'TUNNEL_LIMIT');
    assert.equal(over.localPort, 40004);
    const over2 = await d1.register({ localPort: 40005, protocol: 'tcp' });
    assert.equal(over2.code, 'TUNNEL_LIMIT');
    assert.equal(h.tunnelManager.countLiveTunnelsForToken(token), 3);

    // Tunnels of a closed connection no longer count.
    await d1.close();
    await waitUntil(() => h.tunnelManager.getTunnel(a.tunnelId).status === 'inactive', 3000, 'inactive');
    const d = await d2.register({ localPort: 40004, protocol: 'tcp' });
    assert.equal(d.type, 'registered');

    // Reconnects count too: 2 live (c, d) + a = 3, then b is over the limit.
    const d3 = await device({ token });
    assert.equal((await d3.reconnect(a.tunnelId, a.ownerSecret)).type, 'reconnected');
    const rb = await d3.reconnect(b.tunnelId, b.ownerSecret);
    assert.equal(rb.type, 'error');
    assert.equal(rb.code, 'TUNNEL_LIMIT');
    assert.equal(rb.tunnelId, b.tunnelId);
    assert.equal(h.tunnelManager.getTunnel(b.tunnelId).clientWs, null);
    // Re-attaching a tunnel that is already live on another connection of the token is not "one more".
    const rc = await d3.reconnect(c.tunnelId, c.ownerSecret);
    assert.equal(rc.type, 'reconnected');
    await Promise.all([d2.close(), d3.close()]);
  });

  test('admin-token connections are limited per connection', async () => {
    const d1 = await device();
    const d2 = await device();
    for (const port of [41001, 41002, 41003]) {
      assert.equal((await d1.register({ localPort: port, protocol: 'http', subdomain: `adm${port}` })).type, 'registered');
    }
    assert.equal((await d1.register({ localPort: 41004, protocol: 'http' })).code, 'TUNNEL_LIMIT');
    assert.equal((await d2.register({ localPort: 41004, protocol: 'http' })).type, 'registered');
    await Promise.all([d1.close(), d2.close()]);
  });

  test('connection cap per token: the oldest connection is closed with 4003 (newest wins)', async () => {
    const token = h.createToken('capped');
    const d1 = await device({ token });
    const reg = await d1.register({ localPort: echoPort, protocol: 'tcp' });
    const d2 = await device({ token });
    const d3 = await device({ token });
    const { code, reason } = await d1.closed;
    assert.equal(code, 4003);
    assert.match(reason, /Superseded/);
    assert.equal(d2.ws.readyState, 1);
    assert.equal(d3.ws.readyState, 1);
    assert.equal(h.registry.connectionsForToken(token).length, 2);
    await waitUntil(() => !h.tcpProxy.servers.has(reg.tunnelId), 3000, 'listener of superseded connection stopped');

    // The device's replacement connection takes the tunnel over with its secret.
    const rec = await d3.reconnect(reg.tunnelId, reg.ownerSecret);
    assert.equal(rec.type, 'reconnected');
    assert.equal(rec.allocatedPort, reg.allocatedPort);
    const s = await openEcho(rec.allocatedPort);
    s.destroy();

    // Admin connections are not capped per token.
    const admins = [await device(), await device(), await device()];
    await new Promise(r => setTimeout(r, 100));
    for (const a of admins) assert.equal(a.ws.readyState, 1);
    await Promise.all([d2.close(), d3.close(), ...admins.map(a => a.close())]);
  });

  test('removeTunnelsForToken removes every tunnel of the token and closes its devices', async () => {
    const token = h.createToken('deleted-token');
    const other = h.createToken('bystander');
    const d = await device({ token });
    const dOther = await device({ token: other });
    const t1 = await d.register({ localPort: echoPort, protocol: 'tcp' });
    const t2 = await d.register({ localPort: 8081, protocol: 'http', subdomain: 'gone' });
    const keep = await dOther.register({ localPort: echoPort, protocol: 'tcp' });

    assert.equal(h.tunnelManager.removeTunnelsForToken(token), 2);
    assert.equal((await d.closed).code, 4000);
    assert.equal(h.tunnelManager.getTunnel(t1.tunnelId), null);
    assert.equal(h.tunnelManager.getTunnel(t2.tunnelId), null);
    assert.equal(h.db.queryOne('SELECT COUNT(*) AS n FROM tunnels WHERE client_token = ?', [token]).n, 0);
    assert.equal(h.tcpProxy.servers.has(t1.tunnelId), false);
    await waitUntil(() => connectRefused(t1.allocatedPort), 3000, 'port closed');
    assert.equal(h.tunnelManager.getTunnelBySubdomain('gone'), null);

    assert.equal(h.tunnelManager.getTunnel(keep.tunnelId).status, 'active');
    assert.equal(dOther.ws.readyState, 1);
    assert.equal(h.tunnelManager.removeTunnelsForToken(token), 0);
    assert.equal(h.tunnelManager.removeTunnelsForToken(''), 0);
    await dOther.close();
  });

  test('cleanupIdleTunnels removes only old inactive tunnels', async () => {
    const dLive = await device({ token: h.createToken('idle-live') });
    const live = await dLive.register({ localPort: 42001, protocol: 'http', subdomain: 'idle-live' });
    const dGone = await device({ token: h.createToken('idle-gone') });
    const idle = await dGone.register({ localPort: 42002, protocol: 'http', subdomain: 'idle-old' });
    const recent = await dGone.register({ localPort: 42003, protocol: 'http', subdomain: 'idle-recent' });
    const paused = await dGone.register({ localPort: 42004, protocol: 'http', subdomain: 'idle-paused' });
    await dGone.close();
    await waitUntil(() => h.tunnelManager.getTunnel(idle.tunnelId).status === 'inactive', 3000, 'inactive');

    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const tm = h.tunnelManager;
    tm.getTunnel(idle.tunnelId).lastActivity = old;
    tm.getTunnel(paused.tunnelId).lastActivity = old;
    tm.getTunnel(paused.tunnelId).status = 'paused';
    tm.getTunnel(live.tunnelId).lastActivity = old; // active: never removed
    // A record without last_activity falls back to created_at.
    tm.getTunnel(recent.tunnelId).lastActivity = null;

    assert.equal(tm.cleanupIdleTunnels(0), 0, '0 disables the cleanup');
    assert.equal(tm.cleanupIdleTunnels(30 * 86400_000), 1);
    assert.equal(tm.getTunnel(idle.tunnelId), null);
    assert.equal(h.db.queryOne('SELECT id FROM tunnels WHERE id = ?', [idle.tunnelId]), undefined);
    assert.ok(tm.getTunnel(recent.tunnelId));
    assert.ok(tm.getTunnel(paused.tunnelId));
    assert.ok(tm.getTunnel(live.tunnelId));

    tm.getTunnel(recent.tunnelId).createdAt = '2000-01-01 00:00:00';
    assert.equal(tm.cleanupIdleTunnels(30 * 86400_000), 1);
    assert.equal(tm.getTunnel(recent.tunnelId), null);
    await dLive.close();
  });

  test('traffic stats are batched: no per-packet DB writes, one transaction per flush', async () => {
    const d = await device();
    const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
    const db = h.db;
    const origRun = db.run;
    const origTx = db.transaction;
    const statements = [];
    let inTx = false;
    let transactions = 0;
    db.run = (sql, params) => {
      statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), inTx });
      return origRun(sql, params);
    };
    db.transaction = (fn) => {
      transactions++;
      inTx = true;
      try { return origTx(fn); } finally { inTx = false; }
    };
    try {
      const t0 = Date.now();
      const payload = crypto.randomBytes(4 * 1024 * 1024);
      const s = net.connect(reg.allocatedPort, '127.0.0.1');
      let got = 0;
      const chunks = [];
      await new Promise((resolve, reject) => {
        s.on('data', (c) => { chunks.push(c); got += c.length; if (got >= payload.length) resolve(); });
        s.on('error', reject);
        s.write(payload);
      });
      s.end();
      assert.ok(Buffer.concat(chunks).equals(payload));
      const elapsed = Date.now() - t0;
      await waitUntil(() => db.queryOne('SELECT bytes_transferred AS b FROM tunnels WHERE id = ?', [reg.tunnelId]).b
        === h.tunnelManager.getTunnel(reg.tunnelId).bytesTransferred, 3000, 'stats flushed');

      const statUpdates = statements.filter(st => st.sql.startsWith('UPDATE tunnels SET connections'));
      assert.ok(chunks.length >= 16, 'many chunks were transferred');
      assert.ok(statUpdates.length >= 1);
      // At most one stats UPDATE per flush interval (250 ms) for this tunnel, never per chunk.
      assert.ok(statUpdates.length <= Math.ceil((Date.now() - t0) / 250) + 2,
        `${statUpdates.length} stat updates in ${elapsed} ms`);
      assert.ok(statUpdates.every(st => st.inTx), 'stats are written inside a transaction');
      assert.ok(transactions >= 1);
      const other = statements.filter(st => !st.sql.startsWith('UPDATE tunnels SET connections'));
      assert.ok(other.length <= 4, `unexpected writes: ${JSON.stringify(other.map(o => o.sql))}`);
      const row = db.queryOne('SELECT connections, bytes_transferred, last_activity FROM tunnels WHERE id = ?', [reg.tunnelId]);
      assert.equal(row.connections, 1);
      assert.ok(row.bytes_transferred >= payload.length * 2);
      assert.ok(Date.parse(row.last_activity) >= t0 - 1000);
    } finally {
      db.run = origRun;
      db.transaction = origTx;
    }
    await d.close();
  });
});

describe('TunnelManager stats flushing (unit)', () => {
  function fakeDb() {
    const calls = { run: [], tx: 0 };
    return {
      calls,
      query: () => [],
      queryOne: () => undefined,
      run: (sql, params) => { calls.run.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { changes: 1 }; },
      transaction: (fn) => { calls.tx++; return fn(); },
    };
  }
  const fakeWs = { readyState: 1, clientId: 'c1' };

  test('flushStats writes all dirty tunnels in one transaction; destroy() flushes and stops the timer', async () => {
    const db = fakeDb();
    const tm = new TunnelManager(db, { statsFlushMs: 60_000 });
    const a = tm.createTunnel({ name: 'a', localPort: 1, protocol: 'tcp' }, fakeWs);
    const b = tm.createTunnel({ name: 'b', localPort: 2, protocol: 'http' }, fakeWs);
    db.calls.run.length = 0;
    for (let i = 0; i < 1000; i++) tm.addBytes(a.id, 100);
    tm.incrementConnections(a.id);
    tm.addBytes(b.id, 5);
    tm.addBytes(b.id, 0); // ignored
    assert.equal(db.calls.run.length, 0, 'no writes per packet');
    assert.equal(tm.flushStats(), 2);
    assert.equal(db.calls.tx, 1);
    const updates = db.calls.run.filter(c => c.sql.startsWith('UPDATE tunnels SET connections'));
    assert.equal(updates.length, 2);
    const ua = updates.find(u => u.params[3] === a.id);
    assert.deepEqual(ua.params.slice(0, 2), [1, 100_000]);
    assert.equal(tm.flushStats(), 0, 'nothing dirty');
    assert.equal(db.calls.tx, 1);

    tm.addBytes(a.id, 1);
    tm.destroy();
    assert.equal(db.calls.tx, 2, 'destroy flushes');
    tm.addBytes(a.id, 1);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(db.calls.tx, 2);
  });

  test('the flush timer runs at the configured interval', async () => {
    const db = fakeDb();
    const tm = new TunnelManager(db, { statsFlushMs: 50 });
    const a = tm.createTunnel({ name: 'a', localPort: 1, protocol: 'tcp' }, fakeWs);
    tm.addBytes(a.id, 10);
    await waitUntil(() => db.calls.tx === 1, 2000, 'timer flush');
    assert.ok(a.lastActivity);
    tm.destroy();
  });

  test('restored tunnels keep their owner; pre-2.0 rows without owner are claimed by the first valid reconnect', () => {
    const db = fakeDb();
    const secret = 'a'.repeat(64);
    const rows = [
      { id: 'legacy-1', name: 'old', subdomain: 'old', local_port: 22, public_url: 'tcp:10005', status: 'active',
        protocol: 'tcp', allocated_port: 10005, owner_secret: secret, preferred_port: 10005,
        client_token: null, last_activity: null, created_at: '2025-01-01 00:00:00' },
      { id: 'owned-1', name: 'new', subdomain: 'new', local_port: 80, public_url: 'x', status: 'paused',
        protocol: 'http', allocated_port: null, owner_secret: secret, preferred_port: null,
        client_token: 'tokA', last_activity: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01 00:00:00' },
      { id: 'sim-1', name: 'sim', subdomain: 'sim', local_port: 1, status: 'simulated', protocol: 'http', owner_secret: null },
    ];
    db.query = () => rows.filter(r => r.status !== 'simulated');
    const tm = new TunnelManager(db, { statsFlushMs: 60_000 });
    assert.ok(db.calls.run.some(c => c.sql.includes("DELETE FROM tunnels WHERE status = 'simulated'")));
    const legacy = tm.getTunnel('legacy-1');
    const owned = tm.getTunnel('owned-1');
    assert.equal(legacy.status, 'inactive', 'no live connection after a restart');
    assert.equal(owned.status, 'paused', 'a manual pause survives restarts');
    assert.equal(owned.clientToken, 'tokA');
    assert.equal(legacy.preferredPort, 10005);

    const wsA = { readyState: 1, clientId: 'a', clientToken: { token: 'tokA' } };
    const wsB = { readyState: 1, clientId: 'b', clientToken: { token: 'tokB' } };
    const admin = { readyState: 1, clientId: 'adm', clientToken: null };
    assert.equal(tm.verifyReconnect('owned-1', wsB, secret).ok, false, 'other token');
    assert.equal(tm.verifyReconnect('owned-1', admin, secret).ok, false, 'admin token');
    assert.equal(tm.verifyReconnect('owned-1', wsA, 'b'.repeat(64)).ok, false, 'wrong secret');
    assert.equal(tm.verifyReconnect('owned-1', wsA, secret).ok, true);

    assert.equal(tm.reconnect('legacy-1', wsB, 'wrong'), false);
    assert.equal(tm.reconnect('legacy-1', wsB, secret), true, 'claimed with the proven secret');
    assert.equal(legacy.clientToken, 'tokB');
    assert.equal(legacy.status, 'active');
    const persisted = db.calls.run.find(c => c.sql.startsWith('UPDATE tunnels SET status = ?, client_token = ?') && c.params[4] === 'legacy-1');
    assert.equal(persisted.params[1], 'tokB');
    tm.markDisconnected('legacy-1', wsB);
    assert.equal(tm.reconnect('legacy-1', wsA, secret), false, 'once claimed, other tokens are refused');
    tm.destroy();
  });

  test('a failed flush is retried', () => {
    const db = fakeDb();
    const tm = new TunnelManager(db, { statsFlushMs: 60_000 });
    const a = tm.createTunnel({ name: 'a', localPort: 1, protocol: 'tcp' }, fakeWs);
    db.transaction = () => { throw new Error('SQLITE_BUSY'); };
    tm.addBytes(a.id, 10);
    assert.equal(tm.flushStats(), 0);
    db.transaction = (fn) => fn();
    assert.equal(tm.flushStats(), 1);
    tm.destroy();
  });

  test('flushStats refreshes last_activity of connected tunnels without traffic (throttled), not of offline ones', () => {
    const db = fakeDb();
    const tm = new TunnelManager(db, { statsFlushMs: 60_000, activityRefreshMs: 3_600_000 });
    const ws = { readyState: 1, clientId: 'c1' };
    const live = tm.createTunnel({ name: 'live', localPort: 1, protocol: 'tcp' }, ws);
    const offWs = { readyState: 1, clientId: 'c2' };
    const off = tm.createTunnel({ name: 'off', localPort: 2, protocol: 'tcp' }, offWs);
    tm.markDisconnected(off.id, offWs);
    offWs.readyState = 3;
    assert.equal(tm.flushStats(), 0, 'fresh tunnels need no refresh');

    const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
    live.lastActivity = old;
    off.lastActivity = old;
    db.calls.run.length = 0;
    const t0 = Date.now();
    assert.equal(tm.flushStats(), 1, 'only the connected tunnel is refreshed');
    const [u] = db.calls.run.filter(c => c.sql.startsWith('UPDATE tunnels SET connections'));
    assert.equal(u.params[3], live.id);
    assert.ok(Date.parse(u.params[2]) >= t0);
    assert.equal(live.lastActivity, u.params[2]);
    assert.equal(off.lastActivity, old, 'an offline tunnel stays idle');
    assert.equal(tm.flushStats(), 0, 'throttled: at most once per activityRefreshMs');

    live.lastActivity = new Date(Date.now() - 3_600_000 - 1000).toISOString();
    assert.equal(tm.flushStats(), 1, 'refreshed again after activityRefreshMs');
    tm.destroy();
  });

  test('beginShutdown records connected tunnels as live at shutdown; later disconnects are not persisted', () => {
    const db = fakeDb();
    const tm = new TunnelManager(db, { statsFlushMs: 60_000 });
    const ws = { readyState: 1, clientId: 'c1' };
    const a = tm.createTunnel({ name: 'a', localPort: 1, protocol: 'tcp' }, ws);
    a.lastActivity = new Date(Date.now() - 40 * DAY_MS).toISOString();
    db.calls.run.length = 0;
    const t0 = Date.now();
    tm.beginShutdown();
    const touched = db.calls.run.filter(c => c.sql.startsWith('UPDATE tunnels SET connections') && c.params[3] === a.id);
    assert.equal(touched.length, 1, 'last_activity of the connected tunnel written');
    assert.ok(Date.parse(touched[0].params[2]) >= t0);
    db.calls.run.length = 0;
    ws.readyState = 3;
    tm.markDisconnected(a.id, ws);
    assert.equal(a.status, 'inactive', 'in memory the device is gone');
    assert.deepEqual(db.calls.run, [], "the DB keeps it live (no 'inactive' written during shutdown)");
    tm.destroy();
    assert.deepEqual(db.calls.run, [], 'nothing left to flush');
  });

  test('createTunnel requires a device connection (no simulated tunnels); API views hide secrets', () => {
    const tm = new TunnelManager(fakeDb(), { statsFlushMs: 60_000 });
    assert.throws(() => tm.createTunnel({ name: 'sim', localPort: 80, protocol: 'http' }));
    const t = tm.createTunnel({ name: 'web', localPort: 80, protocol: 'http', clientToken: 'tok123' }, fakeWs);
    for (const view of [tm.getTunnelInfo(t.id), tm.getAllTunnels()[0]]) {
      assert.equal(view.id, t.id);
      assert.equal(view.ownerSecret, undefined);
      assert.equal(view.clientWs, undefined);
      assert.equal(view.clientToken, 'tok123');
    }
    assert.equal(tm.getTunnelInfo('nope'), null);
    assert.equal(tm.getStats().activeTunnels, 1);
    tm.markDisconnected(t.id, fakeWs);
    assert.equal(tm.getStats().activeTunnels, 0, 'only active tunnels count');
    tm.destroy();
  });
});

describe('upgrade authentication and rate limiting', () => {
  let h;
  const devices = [];
  const device = makeDeviceFactory(() => h, devices);

  before(async () => {
    h = await startHarness({
      upgradeAttemptsPerMin: 5,
      authFailuresPerMin: 3,
      // Tests pick the client IP via a header (stands in for a trusted proxy).
      getClientIp: (req) => req.headers['x-test-ip'] || req.socket.remoteAddress,
    });
  });

  after(async () => {
    for (const d of devices) await d.terminate().catch(() => {});
    await h.close();
  });

  test('Bearer auth only: missing, wrong, query-string and revoked tokens get 401', async () => {
    const ip = { 'x-test-ip': '198.51.100.1' };
    const ok = await device({ headers: ip });
    assert.equal((await ok.waitFor(m => m.type === 'hello')).protocolVersion, 2);
    await ok.close();

    await assert.rejects(device({ token: null, headers: ip }), (e) => e.statusCode === 401);
    const qs = new FakeDevice({ url: `${h.wsUrl}?auth_token=${h.authToken}`, token: null, headers: { 'x-test-ip': '198.51.100.2' } });
    devices.push(qs);
    await assert.rejects(qs.connect(), (e) => e.statusCode === 401);
    await assert.rejects(device({ token: 'wrong-token', headers: { 'x-test-ip': '198.51.100.3' } }), (e) => e.statusCode === 401);

    const revoked = h.createToken('revoked');
    h.db.run('UPDATE tokens SET active = 0 WHERE token = ?', [revoked]);
    await assert.rejects(device({ token: revoked, headers: { 'x-test-ip': '198.51.100.4' } }), (e) => e.statusCode === 401);

    const good = h.createToken('good');
    const d = await device({ token: good, headers: { 'x-test-ip': '198.51.100.4' } });
    assert.equal(h.registry.connectionsForToken(good).length, 1);
    await d.close();
  });

  test('10 failed auths/min (here 3) -> 429 even with a valid token; other IPs unaffected', async () => {
    const ip = { 'x-test-ip': '203.0.113.7' };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(device({ token: `bad-${i}`, headers: ip }), (e) => e.statusCode === 401);
    }
    await assert.rejects(device({ headers: ip }), (e) => e.statusCode === 429);
    const other = await device({ headers: { 'x-test-ip': '203.0.113.8' } });
    await other.close();
  });

  test('60 upgrade attempts/min (here 5) per IP -> 429', async () => {
    const ip = { 'x-test-ip': '192.0.2.50' };
    for (let i = 0; i < 5; i++) {
      const d = await device({ headers: ip });
      await d.close();
    }
    await assert.rejects(device({ headers: ip }), (e) => e.statusCode === 429);
  });

  test('protocol v1 peers (no X-TunnelVault-Protocol header) get hello but JSON data frames', async () => {
    const d = await device({ protocol: 1, headers: { 'x-test-ip': '192.0.2.60' } });
    await d.waitFor(m => m.type === 'hello');
    const [ws] = h.registry.connectionsForToken(null).filter(w => w.protocolVersion === 1);
    assert.ok(ws);
    assert.equal(ws.tunnelChannel.binary, false);
    assert.equal(ws.tunnelChannel.flowControl, false);
    await d.close();
  });
});

describe('dev mode (no AUTH_TOKEN)', () => {
  let h;
  const devices = [];
  const device = makeDeviceFactory(() => h, devices);

  before(async () => {
    h = await startHarness({ authToken: '' });
  });

  after(async () => {
    for (const d of devices) await d.terminate().catch(() => {});
    await h.close();
  });

  test('unauthenticated devices connect as admin, device tokens keep their identity, revoked tokens are refused', async () => {
    const anon = await device({ token: null });
    await anon.waitFor(m => m.type === 'hello');
    assert.equal(h.registry.connectionsForToken(null).length, 1);

    const token = h.createToken('dev-device');
    const d = await device({ token });
    assert.equal(h.registry.connectionsForToken(token).length, 1);

    const revoked = h.createToken('dev-revoked');
    h.db.run('UPDATE tokens SET active = 0 WHERE token = ?', [revoked]);
    await assert.rejects(device({ token: revoked }), (e) => e.statusCode === 401);
    await Promise.all([anon.close(), d.close()]);
  });
});

describe('tunnel records survive restarts (idle retention, stable ports)', () => {
  const startupPass = (h) => createMaintenance({ db: h.db, tunnelManager: h.tunnelManager, tunnelIdleRetentionDays: 30 })
    .runStartup();
  const tunnelRow = (id) => realDb.queryOne('SELECT status, last_activity, client_token FROM tunnels WHERE id = ?', [id]);

  function insertRow(fields) {
    const row = {
      name: 'row', local_port: 22, status: 'inactive', created_at: sqlTime(Date.now()), protocol: 'tcp',
      allocated_port: null, owner_secret: crypto.randomBytes(32).toString('hex'), preferred_port: null,
      client_token: null, last_activity: null, ...fields,
    };
    row.id = row.id || crypto.randomUUID();
    row.subdomain = row.subdomain || row.name;
    row.public_url = row.public_url || (row.allocated_port ? `tcp:${row.allocated_port}` : 'tcp:?');
    realDb.run(`INSERT INTO tunnels (id, name, subdomain, local_port, public_url, status, created_at, connections,
        bytes_transferred, protocol, allocated_port, owner_secret, preferred_port, client_token, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.name, row.subdomain, row.local_port, row.public_url, row.status, row.created_at, row.protocol,
      row.allocated_port, row.owner_secret, row.preferred_port, row.client_token, row.last_activity]);
    return row;
  }

  test('a pre-2.0 record (created 60 days ago) survives the upgrade boot and a second restart, then is claimed on its old port', async () => {
    const portMin = 20000 + Math.floor(Math.random() * 150) * 200;
    const P = portMin + 150; // not the first free port: keeping it proves the stable port
    // 1.x shape: the 2.0 columns client_token / last_activity were added as NULL.
    const legacy = insertRow({ name: 'legacy-ssh', local_port: echoPort, status: 'active',
      created_at: sqlTime(Date.now() - 60 * DAY_MS), allocated_port: P, preferred_port: P });

    let h = await startHarness({ portMin });
    try {
      startupPass(h); // what app.start() runs before the listeners open
      assert.ok(h.tunnelManager.getTunnel(legacy.id), 'kept by the startup retention pass');
      h.tunnelManager.cleanupIdleTunnels(30 * DAY_MS);
      assert.ok(h.tunnelManager.getTunnel(legacy.id), 'and by later passes');
      // Nothing persisted: the next start still sees an unclaimed pre-2.0 record.
      assert.deepEqual(tunnelRow(legacy.id), { status: 'inactive', last_activity: null, client_token: null });
    } finally {
      await h.close();
    }

    h = await startHarness({ portMin });
    const d = new FakeDevice({ url: h.wsUrl, token: h.createToken('legacy-device') });
    try {
      startupPass(h);
      assert.ok(h.tunnelManager.getTunnel(legacy.id), 'kept after another restart');
      await d.connect();
      const rec = await d.reconnect(legacy.id, legacy.owner_secret);
      assert.equal(rec.type, 'reconnected', JSON.stringify(rec));
      assert.equal(rec.allocatedPort, P, 'same public port as before the upgrade');
      (await openEcho(P)).destroy();
      const row = tunnelRow(legacy.id);
      assert.equal(row.client_token, d.token, 'claimed by the device token');
      assert.ok(row.last_activity);
    } finally {
      await d.terminate().catch(() => {});
      await h.close();
    }
  });

  test('a pre-2.0 record is still removed once this process has run longer than the retention', async () => {
    const legacy = insertRow({ name: 'legacy-gone', created_at: sqlTime(Date.now() - 60 * DAY_MS) });
    const tm = new TunnelManager(realDb, { statsFlushMs: 60_000 });
    try {
      assert.equal(tm.cleanupIdleTunnels(60_000), 0);
      assert.ok(tm.getTunnel(legacy.id));
      await new Promise(r => setTimeout(r, 30));
      tm.cleanupIdleTunnels(10); // idle since this process started (> 10 ms ago)
      assert.equal(tm.getTunnel(legacy.id), null);
      assert.equal(tunnelRow(legacy.id), undefined);
    } finally {
      tm.destroy();
    }
  });

  test('a record live at the last stop/crash survives a restart however old its last_activity; offline ones still expire', async () => {
    const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
    const created = sqlTime(Date.now() - 100 * DAY_MS);
    const token = 'tok-retention';
    // Device connected (but without traffic) when the server was killed.
    const wasLive = insertRow({ name: 'was-live', status: 'active', client_token: token, last_activity: old, created_at: created });
    // Device offline for 40 days before the restart.
    const offline = insertRow({ name: 'offline', status: 'inactive', client_token: token, last_activity: old, created_at: created });
    const paused = insertRow({ name: 'paused', status: 'paused', client_token: token, last_activity: old, created_at: created });

    const t0 = Date.now();
    const tm = new TunnelManager(realDb, { statsFlushMs: 60_000 });
    try {
      tm.cleanupIdleTunnels(30 * DAY_MS);
      const t = tm.getTunnel(wasLive.id);
      assert.ok(t, 'live at shutdown: kept');
      assert.equal(t.status, 'inactive');
      assert.ok(Date.parse(t.lastActivity) >= t0);
      const row = tunnelRow(wasLive.id);
      assert.equal(row.status, 'inactive');
      assert.ok(Date.parse(row.last_activity) >= t0, 'refreshed last_activity is persisted (survives the next restart too)');

      assert.equal(tm.getTunnel(offline.id), null, 'offline for 40 days: removed');
      assert.equal(tunnelRow(offline.id), undefined);
      assert.ok(tm.getTunnel(paused.id), 'paused: never removed');
      assert.equal(tunnelRow(paused.id).last_activity, old);
    } finally {
      tm.destroy();
    }
  });

  test('a connected device without traffic keeps its tunnel fresh (heartbeat flush)', async () => {
    const h = await startHarness({ statsFlushMs: 50, activityRefreshMs: 200 });
    const d = new FakeDevice({ url: h.wsUrl, token: h.createToken('quiet-device') });
    try {
      await d.connect();
      const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
      const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
      const t0 = Date.now();
      h.tunnelManager.getTunnel(reg.tunnelId).lastActivity = old;
      realDb.run('UPDATE tunnels SET last_activity = ? WHERE id = ?', [old, reg.tunnelId]);
      await waitUntil(() => Date.parse(tunnelRow(reg.tunnelId).last_activity) >= t0, 3000, 'last_activity refreshed');
      assert.equal(h.tunnelManager.getTunnel(reg.tunnelId).bytesTransferred, 0, 'without any traffic');
    } finally {
      await d.terminate().catch(() => {});
      await h.close();
    }
  });

  test('a graceful stop keeps connected tunnels (and their ports) however long the server stays down', async () => {
    const portMin = 20000 + Math.floor(Math.random() * 150) * 200;
    let h = await startHarness({ portMin, statsFlushMs: 60_000 });
    const token = h.createToken('stop-device');
    const d = new FakeDevice({ url: h.wsUrl, token });
    let reg;
    try {
      await d.connect();
      reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
      assert.equal(reg.type, 'registered');
      // Connected for 40 days without traffic.
      const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
      h.tunnelManager.getTunnel(reg.tunnelId).lastActivity = old;
      realDb.run('UPDATE tunnels SET last_activity = ? WHERE id = ?', [old, reg.tunnelId]);
    } finally {
      const t0 = Date.now();
      await h.close();
      const { code } = await d.closed;
      assert.equal(code, 1001);
      await new Promise(r => setTimeout(r, 50)); // let the server-side close handlers run
      const row = tunnelRow(reg.tunnelId);
      assert.equal(row.status, 'active', 'recorded as live at shutdown');
      assert.ok(Date.parse(row.last_activity) >= t0);
    }
    // The server stays down for 40 days.
    realDb.run('UPDATE tunnels SET last_activity = ? WHERE id = ?',
      [new Date(Date.now() - 40 * DAY_MS).toISOString(), reg.tunnelId]);

    h = await startHarness({ portMin });
    const d2 = new FakeDevice({ url: h.wsUrl, token });
    try {
      startupPass(h);
      assert.ok(h.tunnelManager.getTunnel(reg.tunnelId), 'kept by the startup retention pass');
      await d2.connect();
      const rec = await d2.reconnect(reg.tunnelId, reg.ownerSecret);
      assert.equal(rec.type, 'reconnected', JSON.stringify(rec));
      assert.equal(rec.allocatedPort, reg.allocatedPort, 'same public port');
    } finally {
      await d2.terminate().catch(() => {});
      await h.close();
    }
  });
});
