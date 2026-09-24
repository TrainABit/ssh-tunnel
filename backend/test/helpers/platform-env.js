'use strict';

/**
 * Test environment for the PLATFORM work package.
 *
 * MUST be required before anything that loads src/database.js: it points
 * DB_PATH at a fresh temp file and clears environment variables that would
 * change behaviour. Every `node --test` file runs in its own process, so each
 * test file gets its own database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-platform-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'tunnelvault.db');
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'fatal';
process.env.NODE_ENV = 'test';
for (const key of [
  'AUTH_TOKEN', 'TRUST_PROXY', 'BEHIND_PROXY', 'DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY_FILE',
  'DATA_ENCRYPTION_KEY_PREVIOUS', 'DATA_ENCRYPTION_KEY_PREVIOUS_FILE', 'GEOIP_PROVIDER', 'GEOIP_DB',
  'USERMGR_SPOOL_DIR', 'WEBHOOK_URL', 'TLS_CERT', 'TLS_KEY', 'TLS_PROXY_CERT', 'TLS_PROXY_KEY',
  'PORT', 'PROXY_PORT', 'BIND_HOST', 'PUBLIC_URL', 'HTTP_TUNNEL_URL_TEMPLATE', 'ALLOWED_ORIGINS',
  'TCP_BIND_HOST', 'SESSION_RETENTION_DAYS', 'TUNNEL_IDLE_RETENTION_DAYS', 'SESSION_TTL_HOURS',
  'API_RATE_LIMIT_PER_MIN', 'WEB_SSH_RATE_LIMIT_PER_MIN', 'WEB_SSH_MAX_SESSIONS', 'INSTALL_DIR',
  'TUNNELVAULT_UPDATE_CONF', 'TUNNELVAULT_UPDATE_TIMER', 'MAX_TUNNELS_PER_TOKEN', 'LOG_FILE', 'LOG_FORMAT',
]) {
  delete process.env[key];
}
process.env.DOMAIN = 'test.local';
// Never touch the real updater config (or depend on this host's systemd units)
process.env.TUNNELVAULT_UPDATE_CONF = path.join(TMP_DIR, 'update.conf');
process.env.TUNNELVAULT_UPDATE_TIMER = path.join(TMP_DIR, 'tunnelvault-autoupdate.timer');

const ADMIN_TOKEN = 'platform-admin-token-0123456789';

/** Random TCP port window per process so parallel test files rarely collide. */
function tcpPortWindow() {
  const portMin = 30000 + Math.floor(Math.random() * 100) * 200;
  return { portMin, portMax: portMin + 199, bindHost: '127.0.0.1' };
}

/**
 * Boot the full stack (createTunnelVault) on ephemeral ports.
 * @param {object} [opts] - createTunnelVault overrides
 */
async function startVault(opts = {}) {
  const { createTunnelVault } = require('../../src/app');
  const vault = createTunnelVault({
    port: 0,
    proxyPort: 0,
    bindHost: '127.0.0.1',
    authToken: ADMIN_TOKEN,
    closeDbOnStop: false,
    tcpProxyOptions: tcpPortWindow(),
    ...opts,
  });
  const { port, proxyPort } = await vault.start();
  vault.baseUrl = `http://127.0.0.1:${port}`;
  vault.port = port;
  vault.proxyPort = proxyPort;
  return vault;
}

/**
 * Minimal HTTP client: returns { status, headers, body (parsed JSON or text), setCookie: string[] }.
 */
async function request(baseUrl, method, urlPath, { headers = {}, body, bearer, cookie } = {}) {
  const h = { ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['content-type'] = h['content-type'] || 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(baseUrl + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, headers: res.headers, body: parsed, text, setCookie };
}

/** 'name=value; Path=/; …' -> 'name=value' */
function cookiePair(setCookie) {
  return String(setCookie).split(';')[0].trim();
}

/** Poll until fn() is truthy (or throw after timeoutMs). */
async function waitUntil(fn, timeoutMs = 5000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tokenCounter = 0;
/** Insert a device token row directly; returns the token string. */
function insertToken(db, { token, active = 1, privateKey = '', linuxUser } = {}) {
  tokenCounter++;
  const t = token || `tok${process.pid}x${tokenCounter}${Math.random().toString(36).slice(2, 8)}`;
  db.run('INSERT INTO tokens (token, label, linux_user, active, private_key) VALUES (?, ?, ?, ?, ?)',
    [t, 'test', linuxUser || `ws-${t}`, active, privateKey]);
  return t;
}

module.exports = {
  TMP_DIR,
  ADMIN_TOKEN,
  startVault,
  request,
  cookiePair,
  waitUntil,
  insertToken,
  tcpPortWindow,
};
