import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals for services/api.js.
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
const win = new EventTarget();
win.localStorage = makeStorage();
win.sessionStorage = makeStorage();
win.location = { protocol: 'https:', host: 'tunnel.example.com', hostname: 'tunnel.example.com' };
globalThis.window = win;

const calls = [];
let nextResponse = null;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (nextResponse instanceof Error) throw nextResponse;
  const { status = 200, body = '' } = nextResponse || {};
  return new Response(body === '' ? null : body, { status, headers: { 'Content-Type': 'application/json' } });
};
function respond(status, body) {
  nextResponse = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

const api = await import('../src/services/api.js');

beforeEach(() => {
  calls.length = 0;
  nextResponse = null;
  api.clearConfigCache();
});

test('purgeLegacyAuthToken removes the old localStorage admin token', () => {
  win.localStorage.setItem('tunnelvault_auth_token', 'secret');
  win.sessionStorage.setItem('tunnelvault_auth_token', 'secret');
  api.purgeLegacyAuthToken();
  assert.equal(win.localStorage.getItem('tunnelvault_auth_token'), null);
  assert.equal(win.sessionStorage.getItem('tunnelvault_auth_token'), null);
});

test('requests use same-origin credentials and never an Authorization header', async () => {
  win.localStorage.setItem('tunnelvault_auth_token', 'leftover');
  respond(200, { tunnels: [{ id: 'a' }] });
  const tunnels = await api.getTunnels();
  assert.deepEqual(tunnels, [{ id: 'a' }]);
  assert.equal(calls[0].url, '/api/tunnels');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  win.localStorage.removeItem('tunnelvault_auth_token');
});

test('login posts the token as JSON and does not store it', async () => {
  respond(200, { authenticated: true });
  await api.login('adm1n');
  assert.equal(calls[0].url, '/api/auth/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: 'adm1n' });
  assert.equal(win.localStorage.getItem('tunnelvault_auth_token'), null);
});

test('401 dispatches the unauthorized event (but not for auth endpoints)', async () => {
  let fired = 0;
  const onUnauth = () => { fired++; };
  win.addEventListener(api.UNAUTHORIZED_EVENT, onUnauth);
  try {
    respond(401, { error: 'Unauthorized' });
    await assert.rejects(api.getTokens(), (err) => err instanceof api.ApiError && err.status === 401);
    assert.equal(fired, 1);
    respond(401, { error: 'Invalid token' });
    await assert.rejects(api.login('bad'), (err) => err.status === 401);
    assert.equal(fired, 1);
  } finally {
    win.removeEventListener(api.UNAUTHORIZED_EVENT, onUnauth);
  }
});

test('server error messages are surfaced; 429/5xx/network map to ApiError', async () => {
  respond(409, { error: 'Stored keys are disabled: DATA_ENCRYPTION_KEY is not configured' });
  await assert.rejects(api.setTokenPrivateKey('abc', '-----BEGIN X'), (err) =>
    err.status === 409 && /DATA_ENCRYPTION_KEY/.test(err.message));
  assert.deepEqual(JSON.parse(calls[0].init.body), { private_key: '-----BEGIN X' });
  assert.equal(calls[0].init.method, 'PATCH');

  respond(429, '');
  await assert.rejects(api.getSession(), (err) => err.status === 429);

  respond(502, '<html>bad gateway</html>');
  await assert.rejects(api.getStats(), (err) => err.status === 502 && /502/.test(err.message));

  nextResponse = new TypeError('Failed to fetch');
  await assert.rejects(api.getSession(), (err) => err instanceof api.ApiError && err.status === 0);
});

test('non-JSON 2xx bodies are errors, never "logged in"', async () => {
  respond(200, '<!doctype html><html></html>');
  await assert.rejects(api.getSession(), (err) => err instanceof api.ApiError);
  respond(200, { something: 'else' });
  await assert.rejects(api.getSession(), (err) => err instanceof api.ApiError);
  respond(200, { authenticated: false, authRequired: true });
  assert.deepEqual(await api.getSession(), { authenticated: false, authRequired: true });
  respond(200, { authenticated: true, authRequired: false });
  assert.deepEqual(await api.getSession(), { authenticated: true, authRequired: false });
});

test('path parameters are URL-encoded; 204 resolves to null', async () => {
  respond(204, '');
  assert.equal(await api.forgetHostKey('a/b?c'), null);
  assert.equal(calls[0].url, '/api/tunnels/a%2Fb%3Fc/hostkey');
  assert.equal(calls[0].init.method, 'DELETE');
});

test('getConfig is cached, failures are not', async () => {
  respond(500, { error: 'boom' });
  await assert.rejects(api.getConfig());
  respond(200, { version: '2.0.0' });
  assert.deepEqual(await api.getConfig(), { version: '2.0.0' });
  respond(200, { version: 'other' });
  assert.deepEqual(await api.getConfig(), { version: '2.0.0' });
  assert.equal(calls.length, 2);
  assert.deepEqual(await api.getConfig({ force: true }), { version: 'other' });
});

test('SSH WebSocket URL carries no token', () => {
  win.localStorage.setItem('tunnelvault_auth_token', 'leftover');
  const url = api.getSshWsUrl('t-1');
  assert.equal(url, 'wss://tunnel.example.com/ws/ssh?tunnelId=t-1');
  assert.ok(!/token/i.test(url));
  win.location = { protocol: 'http:', host: 'localhost:3000', hostname: 'localhost' };
  assert.equal(api.getSshWsUrl('x y'), 'ws://localhost:3000/ws/ssh?tunnelId=x+y');
  win.localStorage.removeItem('tunnelvault_auth_token');
});
