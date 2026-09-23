'use strict';

const { ADMIN_TOKEN, startVault, request, cookiePair } = require('./helpers/platform-env');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');
const { createTunnelVault, ConfigError } = require('../src/app');

describe('dashboard auth (cookie sessions, Bearer, Origin checks)', () => {
  let vault;
  before(async () => {
    vault = await startVault({ apiRateLimitPerMin: 10_000 });
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

  test('login with the right token sets a hardened session cookie', async () => {
    const r = await login();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { authenticated: true, authRequired: true });
    assert.equal(r.setCookie.length, 1);
    const c = r.setCookie[0];
    assert.match(c, /^tv_session=[A-Za-z0-9_-]{43};/);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Strict/);
    assert.match(c, /; Path=\//);
    assert.match(c, /; Max-Age=43200/);
    assert.doesNotMatch(c, /Secure/); // plain HTTP request
    assert.doesNotMatch(c, /Domain=/i);

    // Only a keyed hash of the session id is stored
    const id = cookiePair(c).split('=')[1];
    const rows = db.query('SELECT id_hash FROM admin_sessions');
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.notEqual(row.id_hash, id);
      assert.ok(!row.id_hash.includes(id));
      assert.match(row.id_hash, /^[0-9a-f]{64}$/);
    }

    const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { cookie: cookiePair(c) });
    assert.deepEqual(s.body, { authenticated: true, authRequired: true });
    const t = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie: cookiePair(c) });
    assert.equal(t.status, 200);
    assert.ok(Array.isArray(t.body.tunnels));
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
    const cookie = cookiePair((await login()).setCookie[0]);
    const host = `127.0.0.1:${vault.port}`;

    const cross = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'x' }, headers: { origin: 'http://evil.example' },
    });
    assert.equal(cross.status, 403);

    // A tunnel subdomain is same-site but NOT same-origin
    const sub = await request(vault.baseUrl, 'DELETE', '/api/tokens/abc', {
      cookie, headers: { origin: 'http://attacker.test.local' },
    });
    assert.equal(sub.status, 403);

    const nullOrigin = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'x' }, headers: { origin: 'null' },
    });
    assert.equal(nullOrigin.status, 403);

    const crossSiteNoOrigin = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'x' }, headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSiteNoOrigin.status, 403);

    const same = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'same-origin' }, headers: { origin: `http://${host}` },
    });
    assert.equal(same.status, 201);

    // Safe methods are not origin-checked
    const get = await request(vault.baseUrl, 'GET', '/api/tokens', { cookie, headers: { origin: 'http://evil.example' } });
    assert.equal(get.status, 200);

    // Bearer requests are not ambient credentials: no Origin requirement
    const bearer = await request(vault.baseUrl, 'POST', '/api/tokens', {
      bearer: ADMIN_TOKEN, body: { label: 'script' }, headers: { origin: 'http://evil.example' },
    });
    assert.equal(bearer.status, 201);
  });

  test('logout clears the cookie and invalidates the session', async () => {
    const cookie = cookiePair((await login()).setCookie[0]);
    const before = db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n;
    const out = await request(vault.baseUrl, 'POST', '/api/auth/logout', { cookie });
    assert.equal(out.status, 200);
    assert.equal(out.body.authenticated, false);
    assert.match(out.setCookie[0], /^tv_session=;/);
    assert.match(out.setCookie[0], /Max-Age=0/);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM admin_sessions').n, before - 1);
    const after = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
    assert.equal(after.status, 401);
  });

  test('expired sessions are rejected and removed', async () => {
    const cookie = cookiePair((await login()).setCookie[0]);
    assert.equal((await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie })).status, 200);
    db.run("UPDATE admin_sessions SET expires_at = datetime('now', '-1 minute')");
    const r = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
    assert.equal(r.status, 401);
    const s = await request(vault.baseUrl, 'GET', '/api/auth/session', { cookie });
    assert.equal(s.body.authenticated, false);
  });

  test('forged or malformed cookies are rejected', async () => {
    for (const cookie of ['tv_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'tv_session=../../etc', `tv_session=${ADMIN_TOKEN}`]) {
      const r = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
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

  test('login rate limit: 10 attempts per minute per IP, X-Forwarded-For ignored without TRUST_PROXY', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(vault.baseUrl, 'POST', '/api/auth/login', {
        body: { token: 'wrong' }, headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      statuses.push(r.status);
    }
    // Earlier tests already used part of this IP's budget; once limited it stays limited
    assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(',')}`);
    assert.equal(statuses[statuses.length - 1], 429);
    // Even the right token is refused while limited
    const ok = await login();
    assert.equal(ok.status, 429);
    assert.equal(ok.headers.get('retry-after'), '60');
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

    const cookie = cookiePair(c);
    const ok = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie, headers });
    assert.equal(ok.status, 200);
    // The __Host- cookie is only valid on HTTPS requests
    const plain = await request(vault.baseUrl, 'GET', '/api/tunnels', { cookie });
    assert.equal(plain.status, 401);

    // Origin is compared with the forwarded host
    const same = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'p' }, headers: { ...headers, origin: 'https://tunnel.example.com' },
    });
    assert.equal(same.status, 201);
    const cross = await request(vault.baseUrl, 'POST', '/api/tokens', {
      cookie, body: { label: 'p' }, headers: { ...headers, origin: 'https://evil.example.com' },
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
    const cookie = cookiePair(r.setCookie[0]);
    assert.equal((await request(v1.baseUrl, 'GET', '/api/tunnels', { cookie })).status, 200);
    await v1.stop();

    const v2 = await startVault({ authToken: 'second-admin-token-bbbbbbbbbbb' });
    try {
      assert.equal((await request(v2.baseUrl, 'GET', '/api/tunnels', { cookie })).status, 401);
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
