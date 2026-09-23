'use strict';

require('./helpers/platform-env');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');
const { createMaintenance } = require('../src/maintenance');

function addSession({ token = null, tunnelId = null, pid = null, connectedAgo, disconnectedAgo = null }) {
  const r = db.run(
    `INSERT INTO sessions (token, client_ip, tunnel_id, pid, connected_at, disconnected_at)
     VALUES (?, '203.0.113.5', ?, ?, datetime('now', ?), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    [token, tunnelId, pid, connectedAgo, disconnectedAgo, disconnectedAgo]
  );
  return Number(r.lastInsertRowid);
}

function sessionRow(id) {
  return db.queryOne('SELECT * FROM sessions WHERE id = ?', [id]);
}

function fakeTunnelManager() {
  const calls = [];
  return { calls, cleanupIdleTunnels(ms) { calls.push(ms); return 2; } };
}

describe('maintenance / retention', () => {
  beforeEach(() => {
    db.run('DELETE FROM sessions');
    db.run('DELETE FROM admin_sessions');
  });

  test('deletes sessions older than SESSION_RETENTION_DAYS, keeps recent ones', () => {
    const old = addSession({ tunnelId: 't1', connectedAgo: '-100 days', disconnectedAgo: '-99 days' });
    const oldNeverClosed = addSession({ pid: 123, connectedAgo: '-200 days' });
    const longButRecentlyEnded = addSession({ tunnelId: 't1', connectedAgo: '-120 days', disconnectedAgo: '-2 days' });
    const recent = addSession({ tunnelId: 't1', connectedAgo: '-1 days', disconnectedAgo: '-1 days' });
    const tm = fakeTunnelManager();
    const m = createMaintenance({ db, tunnelManager: tm, sessionRetentionDays: 90, tunnelIdleRetentionDays: 30 });
    const result = m.runOnce();
    assert.equal(result.sessionsDeleted, 2);
    assert.equal(sessionRow(old), undefined);
    assert.equal(sessionRow(oldNeverClosed), undefined);
    assert.ok(sessionRow(longButRecentlyEnded));
    assert.ok(sessionRow(recent));
    assert.deepEqual(tm.calls, [30 * 24 * 60 * 60 * 1000]);
    assert.equal(result.tunnelsRemoved, 2);
  });

  test('retention 0 keeps everything and disables idle tunnel cleanup', () => {
    const old = addSession({ tunnelId: 't1', connectedAgo: '-1000 days', disconnectedAgo: '-999 days' });
    const tm = fakeTunnelManager();
    const m = createMaintenance({ db, tunnelManager: tm, sessionRetentionDays: 0, tunnelIdleRetentionDays: 0 });
    const result = m.runOnce();
    assert.equal(result.sessionsDeleted, 0);
    assert.ok(sessionRow(old));
    assert.deepEqual(tm.calls, []);
  });

  test('defaults: 90 days sessions, 30 days idle tunnels', () => {
    const m = createMaintenance({ db });
    assert.equal(m.sessionRetentionDays, 90);
    assert.equal(m.tunnelIdleRetentionDays, 30);
    const bad = createMaintenance({ db, sessionRetentionDays: 'abc', tunnelIdleRetentionDays: -5 });
    assert.equal(bad.sessionRetentionDays, 90);
    assert.equal(bad.tunnelIdleRetentionDays, 30);
  });

  test('startup closes open tunnel sessions but not live gateway (sshd) sessions', () => {
    const tunnelOpen = addSession({ tunnelId: 't1', connectedAgo: '-1 hours' });
    const legacyOpen = addSession({ connectedAgo: '-2 hours' }); // pre-2.0 tunnel row: no pid, no tunnel_id
    const gatewayOpen = addSession({ token: 'gw1', pid: 4242, connectedAgo: '-1 hours' });
    const closed = addSession({ tunnelId: 't1', connectedAgo: '-3 hours', disconnectedAgo: '-2 hours' });
    const before = sessionRow(closed).disconnected_at;
    const m = createMaintenance({ db, tunnelManager: fakeTunnelManager() });
    const result = m.runStartup();
    assert.equal(result.sessionsClosed, 2);
    assert.ok(sessionRow(tunnelOpen).disconnected_at);
    assert.ok(sessionRow(legacyOpen).disconnected_at);
    assert.equal(sessionRow(gatewayOpen).disconnected_at, null);
    assert.equal(sessionRow(closed).disconnected_at, before);
  });

  test('expired dashboard sessions are deleted', () => {
    db.run(`INSERT INTO admin_sessions (id_hash, expires_at) VALUES ('a', datetime('now', '-1 hours'))`);
    db.run(`INSERT INTO admin_sessions (id_hash, expires_at) VALUES ('b', datetime('now', '+1 hours'))`);
    const m = createMaintenance({ db, sessionRetentionDays: 0, tunnelIdleRetentionDays: 0 });
    assert.equal(m.runOnce().adminSessionsDeleted, 1);
    assert.deepEqual(db.query('SELECT id_hash FROM admin_sessions').map((r) => r.id_hash), ['b']);
  });

  test('errors in one step do not break the others; timers start and stop', () => {
    const tm = { cleanupIdleTunnels() { throw new Error('nope'); } };
    const m = createMaintenance({ db, tunnelManager: tm, intervalMs: 60_000 });
    const result = m.runOnce();
    assert.equal(result.tunnelsRemoved, 0);
    m.start();
    m.start();
    m.stop();
    m.stop();
  });
});
