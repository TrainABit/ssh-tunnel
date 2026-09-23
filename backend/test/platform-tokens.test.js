'use strict';

const { TMP_DIR, request } = require('./helpers/platform-env');
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const db = require('../src/database');
const tokensRouter = require('../src/routes/tokens');
const userManager = require('../src/userManager');
const { createSecretBox } = require('../src/secretBox');
const { generateKeyPair } = require('./helpers/ssh-keys');

// generateKeyPair: ssh2 keygen retried until the key parses (ssh2 occasionally emits malformed keys).
const PUBKEY = generateKeyPair('ed25519').public;
const PRIVATE_KEY = generateKeyPair('ed25519').private;
const ENCRYPTED_KEY = generateKeyPair('ed25519', { passphrase: 'pw', cipher: 'aes256-cbc', rounds: 4 }).private;

function makeFakes() {
  const calls = { disconnect: [], removeTunnels: [], createUser: [], deleteUser: [] };
  const registry = {
    disconnectToken(token) { calls.disconnect.push(token); return 2; },
  };
  const tunnelManager = {
    removeTunnelsForToken(token) { calls.removeTunnels.push(token); return 3; },
  };
  const fakeUserManager = {
    normalizePublicKey: userManager.normalizePublicKey,
    async createLinuxUser(user, key) { calls.createUser.push([user, key]); return { ok: true, queued: true }; },
    async deleteLinuxUser(user) { calls.deleteUser.push(user); return { ok: false, error: 'boom' }; },
  };
  return { calls, registry, tunnelManager, userManager: fakeUserManager };
}

async function startApp(deps) {
  const app = express();
  app.use(express.json());
  app.use('/api/tokens', tokensRouter(db, deps));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

function assertNoPrivateKey(body) {
  const text = JSON.stringify(body);
  assert.ok(!text.includes('"private_key"'), `response leaks private_key: ${text.slice(0, 200)}`);
  assert.ok(!text.includes('BEGIN'), 'response contains key material');
  assert.ok(!text.includes('tvenc:'), 'response contains the encrypted blob');
}

describe('tokens API', () => {
  let srv;
  let fakes;
  const box = createSecretBox({ key: crypto.randomBytes(32).toString('hex') });

  before(async () => {
    fakes = makeFakes();
    srv = await startApp({ ...fakes, secretBox: box });
  });
  after(async () => {
    await srv.close();
  });
  beforeEach(() => {
    for (const k of Object.keys(fakes.calls)) fakes.calls[k].length = 0;
  });

  test('POST creates a token; GET never returns private_key', async () => {
    const r = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'dev1' } });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^[A-Za-z0-9]{20}$/);
    assert.equal(r.body.linux_user, `ws-${r.body.token}`);
    assert.equal(r.body.linux_user_created, false);
    assert.equal(r.body.linux_user_queued, false);
    assert.equal(fakes.calls.createUser.length, 0);
    const list = await request(srv.base, 'GET', '/api/tokens');
    assertNoPrivateKey(list.body);
    assert.equal(list.body.stored_keys_enabled, true);
    const one = await request(srv.base, 'GET', `/api/tokens/${r.body.token}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.has_private_key, false);
    assertNoPrivateKey(one.body);
  });

  test('PATCH active=0 disconnects the live connections of the token', async () => {
    const { body: { token } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'rev' } });
    const r = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { active: 0 } });
    assert.equal(r.status, 200);
    assert.deepEqual(fakes.calls.disconnect, [token]);
    assert.equal(r.body.disconnected, 2);
    assert.equal(r.body.token.active, 0);
    assertNoPrivateKey(r.body);
    // boolean false is accepted and normalised (used to crash better-sqlite3)
    const r2 = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { active: true } });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.token.active, 1);
    assert.equal(fakes.calls.disconnect.length, 1); // re-activation does not disconnect
    const bad = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { active: 'yes' } });
    assert.equal(bad.status, 400);
  });

  test('DELETE revokes: disconnects, removes tunnels, pins, sessions and the token', async () => {
    const { body: { token } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'del' } });
    const { body: { token: other } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'keep' } });
    db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?)', [`token:${token}:22`, 'ssh-ed25519', 'SHA256:a']);
    db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?)', [`token:${token}:2222`, 'ssh-ed25519', 'SHA256:b']);
    db.run('INSERT INTO ssh_host_keys (pin_key, key_type, fingerprint) VALUES (?, ?, ?)', [`token:${other}:22`, 'ssh-ed25519', 'SHA256:c']);
    db.run('INSERT INTO sessions (token, client_ip) VALUES (?, ?)', [token, '203.0.113.1']);

    const r = await request(srv.base, 'DELETE', `/api/tokens/${token}`);
    assert.equal(r.status, 200);
    assert.deepEqual(fakes.calls.disconnect, [token]);
    assert.deepEqual(fakes.calls.removeTunnels, [token]);
    assert.equal(r.body.disconnected, 2);
    assert.equal(r.body.tunnels_removed, 3);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key LIKE ?', [`token:${token}:%`]).n, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM ssh_host_keys WHERE pin_key = ?', [`token:${other}:22`]).n, 1);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM sessions WHERE token = ?', [token]).n, 0);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM tokens WHERE token = ?', [token]).n, 0);
    assert.equal((await request(srv.base, 'DELETE', `/api/tokens/${token}`)).status, 404);
  });

  test('private_key: validated, encrypted at rest, never returned', async () => {
    const { body: { token } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'key' } });
    const r = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: PRIVATE_KEY } });
    assert.equal(r.status, 200);
    assert.equal(r.body.token.has_private_key, true);
    assertNoPrivateKey(r.body);

    const stored = db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key;
    assert.ok(stored.startsWith(`tvenc:v1:${box.keyId}:`));
    assert.ok(!stored.includes('BEGIN'));
    assert.equal(box.decrypt(stored).trim(), PRIVATE_KEY.trim());

    for (const res of [await request(srv.base, 'GET', '/api/tokens'), await request(srv.base, 'GET', `/api/tokens/${token}`)]) {
      assertNoPrivateKey(res.body);
    }
    const listed = (await request(srv.base, 'GET', '/api/tokens')).body.tokens.find((t) => t.token === token);
    assert.equal(listed.has_private_key, true);

    const enc = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: ENCRYPTED_KEY } });
    assert.equal(enc.status, 400);
    assert.match(enc.body.error, /Passphrase-protected/);
    const junk = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----' } });
    assert.equal(junk.status, 400);
    const pub = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: PUBKEY } });
    assert.equal(pub.status, 400);
    assert.equal(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key, stored);

    const clear = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: '' } });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.token.has_private_key, false);
    assert.equal(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key, '');
  });

  test('gateway tokens: 29-char limit, public key validation, Linux user result surfaced', async () => {
    const t29 = 'a'.repeat(29);
    const t30 = 'b'.repeat(30);
    const long = await request(srv.base, 'POST', '/api/tokens', { body: { token: t30, public_key: PUBKEY } });
    assert.equal(long.status, 400);
    assert.match(long.body.error, /29/);
    // Without a public key long tokens are fine (no Linux user)
    const longNoKey = await request(srv.base, 'POST', '/api/tokens', { body: { token: t30 } });
    assert.equal(longNoKey.status, 201);
    const patchLong = await request(srv.base, 'PATCH', `/api/tokens/${t30}`, { body: { public_key: PUBKEY } });
    assert.equal(patchLong.status, 400);

    const badKey = await request(srv.base, 'POST', '/api/tokens', { body: { token: 'c'.repeat(10), public_key: 'ssh-ed25519 AAAA $(reboot)' } });
    assert.equal(badKey.status, 400);

    const ok = await request(srv.base, 'POST', '/api/tokens', { body: { token: t29, public_key: `${PUBKEY}\n` } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.linux_user, `gw-${t29}`);
    assert.equal(ok.body.linux_user_queued, true);
    assert.equal(ok.body.linux_user_created, false);
    assert.deepEqual(fakes.calls.createUser, [[`gw-${t29}`, PUBKEY.trim()]]);

    // PATCH public_key re-syncs the gateway user's key
    const other = generateKeyPair('ed25519').public;
    const sync = await request(srv.base, 'PATCH', `/api/tokens/${t29}`, { body: { public_key: other } });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.linux_user_queued, true);
    assert.deepEqual(fakes.calls.createUser[1], [`gw-${t29}`, other.trim()]);
    // Removing the key removes the gateway user; failures are reported
    const rm = await request(srv.base, 'PATCH', `/api/tokens/${t29}`, { body: { public_key: '' } });
    assert.equal(rm.status, 200);
    assert.deepEqual(fakes.calls.deleteUser, [`gw-${t29}`]);
    assert.equal(rm.body.linux_user_synced, false);
    assert.equal(rm.body.linux_user_error, 'boom');

    const del = await request(srv.base, 'DELETE', `/api/tokens/${t29}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.linux_user_deleted, false);
    assert.equal(del.body.linux_user_error, 'boom');
  });

  test('input validation', async () => {
    assert.equal((await request(srv.base, 'POST', '/api/tokens', { body: { token: 'has space' } })).status, 400);
    assert.equal((await request(srv.base, 'POST', '/api/tokens', { body: { target_ip: '999.1.1.1' } })).status, 400);
    assert.equal((await request(srv.base, 'GET', '/api/tokens/bad-token!')).status, 400);
    const { body: { token } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'v' } });
    assert.equal((await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { target_port: 70000 } })).status, 400);
    assert.equal((await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: {} })).status, 400);
    assert.equal((await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { target_ip: '' } })).status, 200);
    assert.equal((await request(srv.base, 'PATCH', '/api/tokens/doesnotexist', { body: { label: 'x' } })).status, 404);
  });
});

describe('tokens API without DATA_ENCRYPTION_KEY', () => {
  test('storing a private key is refused with a clear message; clearing works', async () => {
    const fakes = makeFakes();
    const srv = await startApp({ ...fakes, secretBox: createSecretBox({}) });
    try {
      const { body: { token } } = await request(srv.base, 'POST', '/api/tokens', { body: { label: 'nokey' } });
      const r = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: PRIVATE_KEY } });
      assert.equal(r.status, 409);
      assert.match(r.body.error, /DATA_ENCRYPTION_KEY/);
      assert.equal(db.queryOne('SELECT private_key FROM tokens WHERE token = ?', [token]).private_key, '');
      const clear = await request(srv.base, 'PATCH', `/api/tokens/${token}`, { body: { private_key: '' } });
      assert.equal(clear.status, 200);
      assert.equal((await request(srv.base, 'GET', '/api/tokens')).body.stored_keys_enabled, false);
    } finally {
      await srv.close();
    }
  });
});

describe('userManager spool mode (USERMGR_SPOOL_DIR)', () => {
  test('writes atomic 0600 request files and resolves queued', async () => {
    const dir = path.join(TMP_DIR, 'usermgr');
    fs.mkdirSync(dir, { mode: 0o700 });
    process.env.USERMGR_SPOOL_DIR = dir;
    try {
      const created = await userManager.createLinuxUser('gw-abc123', `${PUBKEY} user@host`);
      assert.deepEqual(created, { ok: true, queued: true });
      const deleted = await userManager.deleteLinuxUser('gw-abc123');
      assert.deepEqual(deleted, { ok: true, queued: true });
      const files = fs.readdirSync(dir).sort();
      assert.equal(files.length, 2);
      for (const f of files) {
        assert.match(f, /^\d+-[0-9a-f]{12}\.req$/);
        assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
      }
      const reqs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      assert.ok(reqs.some((r) => r.action === 'create' && r.username === 'gw-abc123' && r.publicKey === `${PUBKEY.trim()} user@host`));
      assert.ok(reqs.some((r) => r.action === 'delete' && r.username === 'gw-abc123' && !('publicKey' in r)));

      // Invalid input never reaches the spool
      assert.equal((await userManager.createLinuxUser(`gw-${'x'.repeat(30)}`, PUBKEY)).ok, false);
      assert.equal((await userManager.createLinuxUser('root', PUBKEY)).ok, false);
      assert.equal((await userManager.createLinuxUser('gw-abc', 'not a key')).ok, false);
      assert.equal((await userManager.deleteLinuxUser('../etc')).ok, false);
      assert.equal(fs.readdirSync(dir).length, 2);
    } finally {
      delete process.env.USERMGR_SPOOL_DIR;
    }
  });
});
