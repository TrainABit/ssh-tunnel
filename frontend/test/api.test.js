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

// Mock WebSocket: records the constructor arguments.
const sockets = [];
globalThis.WebSocket = class MockWebSocket {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); }
};

const api = await import('../src/services/api.js');

const KEY = 'k'.repeat(21) + '_-' + 'A1'.repeat(10); // 43 chars, base64url

beforeEach(() => {
  calls.length = 0;
  sockets.length = 0;
  win.localStorage.removeItem('tunnelvault_session_key');
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

test('{error, message} bodies surface the explanation; 401 always reads as an expired session', async () => {
  respond(403, { error: 'Forbidden', message: 'Cross-origin request refused' });
  await assert.rejects(api.deleteTunnel('t1'), (err) => err.status === 403 && err.message === 'Cross-origin request refused');

  respond(429, { error: 'Too many requests', message: 'Rate limit exceeded. Try again later.' });
  await assert.rejects(api.getTunnels(), (err) => err.status === 429 && /Rate limit exceeded/.test(err.message));

  respond(401, { error: 'Unauthorized', message: 'Valid AUTH_TOKEN or dashboard session required' });
  await assert.rejects(api.getTunnels(), (err) => err.status === 401 && /session has expired/.test(err.message));

  const long = 'x'.repeat(1000);
  respond(400, { error: long });
  await assert.rejects(api.createToken({ label: 'a' }), (err) => err.status === 400 && err.message.length <= 301);
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

test('login stores the session key and apiFetch sends it as X-TV-Session-Key', async () => {
  assert.equal(KEY.length, 43);
  respond(200, { tunnels: [] });
  await api.getTunnels();
  assert.equal(calls[0].init.headers['X-TV-Session-Key'], undefined);

  respond(200, { authenticated: true, authRequired: true, sessionKey: KEY });
  await api.login('adm1n');
  assert.equal(win.localStorage.getItem('tunnelvault_session_key'), KEY);
  assert.equal(api.getSessionKey(), KEY);

  respond(200, { tunnels: [] });
  await api.getTunnels();
  assert.equal(calls[2].init.headers['X-TV-Session-Key'], KEY);
  assert.equal(calls[2].init.headers.Authorization, undefined);
  assert.equal(calls[2].init.credentials, 'same-origin');
});

test('a malformed session key from the server is never stored or sent', async () => {
  respond(200, { authenticated: true, authRequired: true, sessionKey: 'short\r\nX: y' });
  await api.login('adm1n');
  assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);
  win.localStorage.setItem('tunnelvault_session_key', 'tampered value');
  respond(200, { tunnels: [] });
  await api.getTunnels();
  assert.equal(calls[1].init.headers['X-TV-Session-Key'], undefined);
  api.purgeLegacyAuthToken();
  assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);
});

test('any 401 clears the stored session key (before the unauthorized event fires)', async () => {
  win.localStorage.setItem('tunnelvault_session_key', KEY);
  let keyAtEvent = 'unset';
  const onUnauth = () => { keyAtEvent = win.localStorage.getItem('tunnelvault_session_key'); };
  win.addEventListener(api.UNAUTHORIZED_EVENT, onUnauth);
  try {
    respond(401, { error: 'Unauthorized' });
    await assert.rejects(api.getTokens(), (err) => err.status === 401);
    assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);
    assert.equal(keyAtEvent, null);
    // Also for requests that do not notify (session probe).
    win.localStorage.setItem('tunnelvault_session_key', KEY);
    respond(401, { error: 'Unauthorized' });
    await assert.rejects(api.getSession(), (err) => err.status === 401);
    assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);
  } finally {
    win.removeEventListener(api.UNAUTHORIZED_EVENT, onUnauth);
  }
});

test('logout sends the key, then clears it (also when the request fails)', async () => {
  win.localStorage.setItem('tunnelvault_session_key', KEY);
  respond(200, { authenticated: false, authRequired: true });
  await api.logout();
  assert.equal(calls[0].url, '/api/auth/logout');
  assert.equal(calls[0].init.headers['X-TV-Session-Key'], KEY);
  assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);

  win.localStorage.setItem('tunnelvault_session_key', KEY);
  respond(500, { error: 'boom' });
  await assert.rejects(api.logout());
  assert.equal(win.localStorage.getItem('tunnelvault_session_key'), null);
});

test('session probe without a stored key counts as logged out (forced re-login after upgrade)', async () => {
  respond(200, { authenticated: true, authRequired: true });
  assert.deepEqual(await api.getSession(), { authenticated: false, authRequired: true });
  win.localStorage.setItem('tunnelvault_session_key', KEY);
  respond(200, { authenticated: true, authRequired: true });
  assert.deepEqual(await api.getSession(), { authenticated: true, authRequired: true });
  // Servers without AUTH_TOKEN need no key.
  win.localStorage.removeItem('tunnelvault_session_key');
  respond(200, { authenticated: true, authRequired: false });
  assert.deepEqual(await api.getSession(), { authenticated: true, authRequired: false });
});

test('SSH WebSocket is opened with the tunnelvault.v1 and tv-key.<key> subprotocols', () => {
  win.location = { protocol: 'https:', host: 'tunnel.example.com', hostname: 'tunnel.example.com' };
  win.localStorage.setItem('tunnelvault_session_key', KEY);
  const ws = api.openSshSocket('t-1');
  assert.equal(sockets.length, 1);
  assert.equal(ws.url, 'wss://tunnel.example.com/ws/ssh?tunnelId=t-1');
  assert.ok(!ws.url.includes(KEY));
  assert.deepEqual(ws.protocols, ['tunnelvault.v1', `tv-key.${KEY}`]);
});

test('SSH WebSocket without a stored key: 401 when auth is required, tunnelvault.v1 only otherwise', () => {
  assert.throws(() => api.openSshSocket('t-1'), (err) => err instanceof api.ApiError && err.status === 401);
  assert.equal(sockets.length, 0);
  const ws = api.openSshSocket('t-1', { authRequired: false });
  assert.deepEqual(ws.protocols, ['tunnelvault.v1']);
});
