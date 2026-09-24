'use strict';

const { TMP_DIR, ADMIN_TOKEN, startVault, request, cookiePair } = require('./helpers/platform-env');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const db = require('../src/database');
const { createTunnelVault, ConfigError } = require('../src/app');
const { parseCookieValues } = require('../src/auth');

/** Cookie + session key of a login response, and the headers a dashboard request carries. */
function sessionOf(loginResponse, extraHeaders = {}) {
  const cookie = cookiePair(loginResponse.setCookie[0]);
  const key = loginResponse.body.sessionKey;
  return { cookie, key, headers: { ...extraHeaders, cookie, 'x-tv-session-key': key } };
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('dashboard auth (cookie sessions, Bearer, Origin checks)', () => {
  let vault;
  before(async () => {
    // Many logins below: the login/Bearer limit itself is tested with a fresh vault further down.
    vault = await startVault({ apiRateLimitPerMin: 10_000, loginAttemptsPerMin: 1000 });
  });
  after(async () => {
    await vault.stop();
  });

  async function login(headers = {}) {
    return request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: ADMIN_TOKEN }, headers });
  }

  test('session endpoint without credentials: not authenticated, auth required', async () => {
    const r = await request(vault.baseUrl, 'GET', '/api/auth/session');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { authenticated: false, authRequired: true });
  });

  test('login with the right token sets a hardened session cookie and returns the session key', async () => {
    const r = await login();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(r.body).sort(), ['authRequired', 'authenticated', 'sessionKey']);
    assert.equal(r.body.authenticated, true);
    assert.equal(r.body.authRequired, true);
    assert.match(r.body.sessionKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.setCookie.length, 1);
    const c = r.setCookie[0];
    assert.match(c, /^tv_session=[A-Za-z0-9_-]{43};/);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Strict/);
    assert.match(c, /; Path=\//);
    assert.match(c, /; Max-Age=43200/);
    assert.doesNotMatch(c, /Secure/); // plain HTTP request
    assert.doesNotMatch(c, /Domain=/i);

    // Only a keyed hash of the session id and a sha256 of the session key are stored
    const id = cookiePair(c).split('=')[1];
    assert.notEqual(r.body.sessionKey, id);
    const rows = db.query('SELECT id_hash, key_hash FROM admin_sessions');
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.notEqual(row.id_hash, id);
      assert.ok(!row.id_hash.includes(id));
      assert.match(row.id_hash, /^[0-9a-f]{64}$/);
      assert.match(row.key_hash, /^[0-9a-f]{64}$/);
      assert.ok(!row.key_hash.includes(r.body.sessionKey));
    }
    assert.ok(rows.some((row) => row.key_hash === sha256hex(r.body.sessionKey)));

    const { headers } = sessionOf(r);
    const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { headers });
    assert.deepEqual(s.body, { authenticated: true, authRequired: true });
    const t = await request(vault.baseUrl, 'GET', '/api/tunnels', { headers });
    assert.equal(t.status, 200);
    assert.ok(Array.isArray(t.body.tunnels));
  });

  test('a session cookie alone is useless: every request needs the matching X-TV-Session-Key', async () => {
    const r = await login();
    const { cookie, key, headers } = sessionOf(r);
    const host = `127.0.0.1:${vault.port}`;
    // Cookie only (what a device-controlled port on the same host receives): refused everywhere
    const onlyCookie = await request(vault.baseUrl, 'GET', '/api/tokens', { cookie });
    assert.equal(onlyCookie.status, 401);
    const status = await request(vault.baseUrl, 'GET', '/api/auth/session', { cookie });
    assert.deepEqual(status.body, { authenticated: false, authRequired: true });
    const post = await request(vault.baseUrl, 'POST', '/api/tokens', { cookie, body: { label: 'x' } });
    assert.equal(post.status, 401);
    const postSameOrigin = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'x' }, headers: { origin: `http://${host}` },
    });
    assert.equal(postSameOrigin.status, 401);
    // Cookie + key: authenticated
    const ok = await request(vault.baseUrl, 'GET', '/api/tokens', { headers });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.tokens));
    // Wrong / malformed key, or the key without the cookie: refused
    const otherKey = crypto.randomBytes(32).toString('base64url');
    const lastCharFlipped = key.slice(0, 42) + (key[42] === 'A' ? 'B' : 'A');
    for (const bad of [otherKey, lastCharFlipped, 'short', `${key} ${key}`]) {
      const w = await request(vault.baseUrl, 'GET', '/api/tokens', { cookie, headers: { 'x-tv-session-key': bad } });
      assert.equal(w.status, 401, `key ${JSON.stringify(bad)}`);
      const ws = await request(vault.baseUrl, 'GET', '/api/auth/session', { cookie, headers: { 'x-tv-session-key': bad } });
      assert.equal(ws.body.authenticated, false);
    }
    const keyOnly = await request(vault.baseUrl, 'GET', '/api/tokens', { headers: { 'x-tv-session-key': key } });
    assert.equal(keyOnly.status, 401);
    // Another session's key does not unlock this cookie
    const other = sessionOf(await login());
    const mixed = await request(vault.baseUrl, 'GET', '/api/tokens', { cookie, headers: { 'x-tv-session-key': other.key } });
    assert.equal(mixed.status, 401);
  });

  test('cookie tossing: a planted tv_session sent first does not shadow the real session', async () => {
    const { cookie, key } = sessionOf(await login());
    const real = cookie.split('=')[1];
    const bogus = crypto.randomBytes(32).toString('base64url');
    const other = sessionOf(await login()).cookie.split('=')[1]; // a valid id, but not for this key
    for (const header of [
      `tv_session=${bogus}; tv_session=${real}`,
      `tv_session=${other}; tv_session=${real}`,
      `tv_session=junk; other=1; tv_session="${real}"`,
    ]) {
      const r = await request(vault.baseUrl, 'GET', '/api/tokens', { headers: { cookie: header, 'x-tv-session-key': key } });
      assert.equal(r.status, 200, header);
      const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { headers: { cookie: header, 'x-tv-session-key': key } });
      assert.equal(s.body.authenticated, true, header);
    }
    assert.deepEqual(parseCookieValues(`a=1; tv_session=x; b=2; tv_session="y"`, 'tv_session'), ['x', 'y']);
    assert.deepEqual(parseCookieValues('', 'tv_session'), []);
  });

  test('sessions without a key hash (created before key binding) are rejected and removed', async () => {
    const r = await login();
    const { headers } = sessionOf(r);
    assert.equal((await request(vault.baseUrl, 'GET', '/api/tokens', { headers })).status, 200);
    const row = db.queryOne('SELECT id_hash FROM admin_sessions WHERE key_hash = ?', [sha256hex(r.body.sessionKey)]);
    assert.ok(row);
    db.run('UPDATE admin_sessions SET key_hash = NULL WHERE id_hash = ?', [row.id_hash]);
    assert.equal((await request(vault.baseUrl, 'GET', '/api/tokens', { headers })).status, 401);
    const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { headers });
    assert.equal(s.body.authenticated, false);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions WHERE id_hash = ?', [row.id_hash]).n, 0);
  });

  test('login with a wrong token -> 401, no cookie', async () => {
    const r = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: 'nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.setCookie.length, 0);
    const r2 = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: {} });
    assert.equal(r2.status, 401);
  });

  test('Bearer AUTH_TOKEN still works; wrong Bearer and ?auth_token are rejected', async () => {
    const ok = await request(vault.baseUrl, 'GET', '/api/stats', { bearer: ADMIN_TOKEN });
    assert.equal(ok.status, 200);
    const bad = await request(vault.baseUrl, 'GET', '/api/stats', { bearer: 'wrong-token' });
    assert.equal(bad.status, 401);
    const query = await request(vault.baseUrl, 'GET', `/api/stats?auth_token=${ADMIN_TOKEN}`);
    assert.equal(query.status, 401);
    const none = await request(vault.baseUrl, 'GET', '/api/tokens');
    assert.equal(none.status, 401);
  });

  test('cookie-authenticated unsafe requests must be same-origin', async () => {
    const { headers: auth } = sessionOf(await login());
    const host = `127.0.0.1:${vault.port}`;

    const cross = await request(vault.baseUrl, 'POST', '/api/tokens', {
      body: { label: 'x' }, headers: { ...auth, origin: 'http://evil.example' },
    });
    assert.equal(cross.status, 403);

    // A tunnel subdomain is same-site but NOT same-origin
    const sub = await request(vault.baseUrl, 'DELETE', '/api/tokens/abc', {
      headers: { ...auth, origin: 'http://attacker.test.local' },
    });
    assert.equal(sub.status, 403);

    const nullOrigin = await request(vault.baseUrl, 'POST', '/api/tokens', {
      body: { label: 'x' }, headers: { ...auth, origin: 'null' },
    });
    assert.equal(nullOrigin.status, 403);

    const crossSiteNoOrigin = await request(vault.baseUrl, 'POST', '/api/tokens', {
      body: { label: 'x' }, headers: { ...auth, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSiteNoOrigin.status, 403);

    const same = await request(vault.baseUrl, 'POST', '/api/tokens', {
      body: { label: 'same-origin' }, headers: { ...auth, origin: `http://${host}` },
    });
    assert.equal(same.status, 201);

    // Safe methods are not origin-checked
    const get = await request(vault.baseUrl, 'GET', '/api/tokens', { headers: { ...auth, origin: 'http://evil.example' } });
    assert.equal(get.status, 200);

    // Bearer requests are not ambient credentials: no Origin requirement
    const bearer = await request(vault.baseUrl, 'POST', '/api/tokens', {
      bearer: ADMIN_TOKEN, body: { label: 'script' }, headers: { origin: 'http://evil.example' },
    });
    assert.equal(bearer.status, 201);
  });

  test('logout clears the cookie and invalidates the session (only with the session key)', async () => {
    const { cookie, headers } = sessionOf(await login());
    const before = db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n;
    // A captured cookie cannot end the admin's session
    const replay = await request(vault.baseUrl, 'POST', '/api/auth/logout', { cookie });
    assert.equal(replay.status, 200);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n, before);
    assert.equal((await request(vault.baseUrl, 'GET', '/api/tunnels', { headers })).status, 200);

    const out = await request(vault.baseUrl, 'POST', '/api/auth/logout', { headers });
    assert.equal(out.status, 200);
    assert.equal(out.body.authenticated, false);
    assert.match(out.setCookie[0], /^tv_session=;/);
    assert.match(out.setCookie[0], /Max-Age=0/);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n, before - 1);
    const after = await request(vault.baseUrl, 'GET', '/api/tunnels', { headers });
    assert.equal(after.status, 401);
  });

  test('expired sessions are rejected and removed', async () => {
    const { headers } = sessionOf(await login());
    assert.equal((await request(vault.baseUrl, 'GET', '/api/tunnels', { headers })).status, 200);
    db.run("UPDATE admin_sessions SET expires_at = datetime('now', '-1 minute')");
    const r = await request(vault.baseUrl, 'GET', '/api/tunnels', { headers });
    assert.equal(r.status, 401);
    const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { headers });
    assert.equal(s.body.authenticated, false);
  });

  test('forged or malformed cookies are rejected', async () => {
    const key = crypto.randomBytes(32).toString('base64url');
    for (const cookie of ['tv_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'tv_session=../../etc', `tv_session=${ADMIN_TOKEN}`]) {
      const r = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie, headers: { 'x-tv-session-key': key } });
      assert.equal(r.status, 401);
    }
  });

  test('security headers: CSP without Google Fonts, no HSTS over HTTP, no x-powered-by', async () => {
    const r = await request(vault.baseUrl, 'GET', '/api/health');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(!csp.includes('googleapis'));
    assert.ok(!csp.includes('gstatic'));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(r.headers.get('strict-transport-security'), null);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    // X-Forwarded-Proto is ignored without TRUST_PROXY
    const r2 = await request(vault.baseUrl, 'GET', '/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r2.headers.get('strict-transport-security'), null);
    const l = await login({ 'x-forwarded-proto': 'https' });
    assert.match(l.setCookie[0], /^tv_session=/);
  });

  test('unknown API routes return JSON 404; POST /api/tunnels is gone', async () => {
    const r = await request(vault.baseUrl, 'GET', '/api/does-not-exist', { bearer: ADMIN_TOKEN });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Not found');
    const p = await request(vault.baseUrl, 'POST', '/api/tunnels', { bearer: ADMIN_TOKEN, body: { name: 'sim' } });
    assert.equal(p.status, 405);
    assert.equal(vault.tunnelManager.getAllTunnels().length, 0);
  });

});

describe('login and Bearer rate limits (10 per minute per IP, no TRUST_PROXY)', () => {
  /** Fresh vault = fresh limiter budget for 127.0.0.1. */
  async function withVault(fn) {
    const vault = await startVault({ apiRateLimitPerMin: 10_000 });
    try {
      await fn(vault);
    } finally {
      await vault.stop();
    }
  }

  test('login rate limit: 10 attempts per minute per IP, X-Forwarded-For ignored without TRUST_PROXY', async () => {
    await withVault(async (vault) => {
      const statuses = [];
      for (let i = 0; i < 12; i++) {
        const r = await request(vault.baseUrl, 'POST', '/api/auth/login', {
          body: { token: 'wrong' }, headers: { 'x-forwarded-for': `203.0.113.${i}` },
        });
        statuses.push(r.status);
      }
      assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
      // Even the right token is refused while limited
      const ok = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: ADMIN_TOKEN } });
      assert.equal(ok.status, 429);
      assert.equal(ok.headers.get('retry-after'), '60');
    });
  });

  test('GET /api/auth/session is not an AUTH_TOKEN oracle: Bearer guesses are rate limited', async () => {
    await withVault(async (vault) => {
      const right = await request(vault.baseUrl, 'GET', '/api/auth/session', { bearer: ADMIN_TOKEN });
      assert.deepEqual(right.body, { authenticated: true, authRequired: true });
      for (let i = 0; i < 10; i++) {
        const r = await request(vault.baseUrl, 'GET', '/api/auth/session', { bearer: `wrong-guess-${i}` });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { authenticated: false, authRequired: true });
      }
      const eleventh = await request(vault.baseUrl, 'GET', '/api/auth/session', { bearer: 'wrong-guess-10' });
      assert.equal(eleventh.status, 429);
      assert.equal(eleventh.headers.get('retry-after'), '60');
      const correct = await request(vault.baseUrl, 'GET', '/api/auth/session', { bearer: ADMIN_TOKEN });
      assert.equal(correct.status, 429);
      assert.equal(correct.body.authenticated, undefined, 'no answer while limited');
      // The same budget covers /api and login
      assert.equal((await request(vault.baseUrl, 'GET', '/api/tokens', { bearer: ADMIN_TOKEN })).status, 429);
      assert.equal((await request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: ADMIN_TOKEN } })).status, 429);
      // Without a Bearer header the session endpoint still answers (the dashboard's cookie check)
      const plain = await request(vault.baseUrl, 'GET', '/api/auth/session');
      assert.deepEqual(plain.body, { authenticated: false, authRequired: true });
    });
  });

  test('wrong Bearer attempts on /api lock /api/auth/session too', async () => {
    await withVault(async (vault) => {
      for (let i = 0; i < 10; i++) {
        assert.equal((await request(vault.baseUrl, 'GET', '/api/tokens', { bearer: `nope-${i}` })).status, 401);
      }
      const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { bearer: ADMIN_TOKEN });
      assert.equal(s.status, 429);
      assert.equal(s.headers.get('retry-after'), '60');
    });
  });
});

describe('admin_sessions.key_hash migration', () => {
  test('an existing database gains key_hash and drops its (keyless) sessions once', () => {
    const Database = require('better-sqlite3');
    const file = path.join(TMP_DIR, 'pre-keybinding.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE admin_sessions (
      id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL, last_seen TEXT, ip TEXT, user_agent TEXT)`);
    old.prepare("INSERT INTO admin_sessions (id_hash, expires_at) VALUES ('a', datetime('now', '+1 hour'))").run();
    old.close();

    const probe = `const db = require('./src/database');
      const cols = db.query('PRAGMA table_info(admin_sessions)').map((c) => c.name);
      const n = db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n;
      if (process.argv[1] === 'insert') {
        db.run("INSERT INTO admin_sessions (id_hash, key_hash, expires_at) VALUES ('b', 'x', datetime('now', '+1 hour'))");
      }
      db.close();
      process.stdout.write(JSON.stringify({ cols, n }));`;
    const run = (arg) => {
      const r = spawnSync(process.execPath, ['-e', probe, arg], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file }, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const first = run('insert');
    assert.ok(first.cols.includes('key_hash'));
    assert.equal(first.n, 0, 'sessions without a key are removed by the migration');
    const second = run('noop');
    assert.equal(second.n, 1, 'later starts keep (keyed) sessions');
  });
});

describe('behind a trusted reverse proxy (TRUST_PROXY=loopback)', () => {
  let vault;
  before(async () => {
    vault = await startVault({ trustProxy: 'loopback', apiRateLimitPerMin: 10_000 });
  });
  after(async () => {
    await vault.stop();
  });

  test('HTTPS via X-Forwarded-Proto: __Host- cookie with Secure, HSTS', async () => {
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tunnel.example.com' };
    const r = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: { token: ADMIN_TOKEN }, headers });
    assert.equal(r.status, 200);
    const c = r.setCookie[0];
    assert.match(c, /^__Host-tv_session=[A-Za-z0-9_-]{43};/);
    assert.match(c, /; Secure/);
    assert.match(c, /; Path=\//);
    assert.doesNotMatch(c, /Domain=/i);
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');

    const { cookie, key } = sessionOf(r);
    const keyed = { ...headers, 'x-tv-session-key': key };
    const ok = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie, headers: keyed });
    assert.equal(ok.status, 200);
    // The session key is required over HTTPS too
    const noKey = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie, headers });
    assert.equal(noKey.status, 401);
    // The __Host- cookie is only valid on HTTPS requests
    const plain = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie, headers: { 'x-tv-session-key': key } });
    assert.equal(plain.status, 401);

    // Origin is compared with the forwarded host
    const same = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'p' }, headers: { ...keyed, origin: 'https://tunnel.example.com' },
    });
    assert.equal(same.status, 201);
    const cross = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'p' }, headers: { ...keyed, origin: 'https://evil.example.com' },
    });
    assert.equal(cross.status, 403);
  });

  test('X-Forwarded-For is honoured: rate limits are per forwarded client', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(vault.baseUrl, 'POST', '/api/auth/login', {
        body: { token: 'wrong' }, headers: { 'x-forwarded-for': '198.51.100.7' },
      });
      assert.equal(r.status, 401);
    }
    const limited = await request(vault.baseUrl, 'POST', '/api/auth/login', {
      body: { token: 'wrong' }, headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    assert.equal(limited.status, 429);
    const other = await request(vault.baseUrl, 'POST', '/api/auth/login', {
      body: { token: ADMIN_TOKEN }, headers: { 'x-forwarded-for': '198.51.100.8' },
    });
    assert.equal(other.status, 200);
  });
});

describe('rotating AUTH_TOKEN invalidates dashboard sessions', () => {
  test('a session created under the old token is rejected', async () => {
    const v1 = await startVault({ authToken: 'first-admin-token-aaaaaaaaaaaa' });
    const r = await request(v1.baseUrl, 'POST', '/api/auth/login', { body: { token: 'first-admin-token-aaaaaaaaaaaa' } });
    const { headers } = sessionOf(r);
    assert.equal((await request(v1.baseUrl, 'GET', '/api/tunnels', { headers })).status, 200);
    await v1.stop();

    const v2 = await startVault({ authToken: 'second-admin-token-bbbbbbbbbbb' });
    try {
      assert.equal((await request(v2.baseUrl, 'GET', '/api/tunnels', { headers })).status, 401);
    } finally {
      await v2.stop();
    }
  });
});

describe('dev mode and production guard', () => {
  test('no AUTH_TOKEN outside production: open API, session reports authRequired=false', async () => {
    const vault = await startVault({ authToken: '', nodeEnv: 'development' });
    try {
      const s = await request(vault.baseUrl, 'GET', '/api/auth/session');
      assert.deepEqual(s.body, { authenticated: true, authRequired: false });
      const t = await request(vault.baseUrl, 'GET', '/api/tunnels');
      assert.equal(t.status, 200);
      const l = await request(vault.baseUrl, 'POST', '/api/auth/login', { body: {} });
      assert.equal(l.status, 200);
      assert.equal(l.body.authRequired, false);
    } finally {
      await vault.stop();
    }
  });

  test('production without AUTH_TOKEN refuses to start with a ConfigError', () => {
    assert.throws(
      () => createTunnelVault({ authToken: '', nodeEnv: 'production', port: 0, proxyPort: 0, closeDbOnStop: false }),
      (err) => err instanceof ConfigError && err.code === 'CONFIG' && /AUTH_TOKEN/.test(err.message)
    );
  });

  test('unreadable TLS files -> actionable ConfigError, not a crash', () => {
    assert.throws(
      () => createTunnelVault({
        tlsCert: '/nonexistent/fullchain.pem', tlsKey: '/nonexistent/privkey.pem',
        port: 0, proxyPort: 0, authToken: ADMIN_TOKEN, closeDbOnStop: false,
      }),
      (err) => err instanceof ConfigError && /TLS_CERT/.test(err.message) && /ENOENT/.test(err.message)
    );
  });
});
