/**
 * TunnelVault dashboard API client.
 *
 * Authentication: POST /api/auth/login sets an HttpOnly session cookie AND returns
 * a per-session key ({sessionKey}) in the JSON body. The cookie alone is not
 * enough: without TLS every port of the dashboard host (TCP tunnel ports, the
 * proxy's ?tunnel= fallback) is same-site with the dashboard and receives its
 * cookie. The key is kept in localStorage, which is scoped to scheme+host+port,
 * so pages served from other ports cannot read it, and is sent as the
 * `X-TV-Session-Key` header on every request (and as a `tv-key.<key>` WebSocket
 * subprotocol for /ws/ssh). The key is not the admin token; it expires and is
 * revoked with the session. The admin AUTH_TOKEN is never stored in the browser.
 * A 401 from any endpoint clears the key and dispatches UNAUTHORIZED_EVENT so the
 * AuthGate can send the user back to the login screen.
 */

// Key used by old dashboard versions to persist the admin token in localStorage.
export const LEGACY_AUTH_TOKEN_KEY = 'tunnelvault_auth_token';

// Fired on window whenever the API answers 401 (session expired / logged out).
export const UNAUTHORIZED_EVENT = 'tunnelvault:unauthorized';

// localStorage key of the per-session key returned by POST /api/auth/login.
export const SESSION_KEY_STORAGE_KEY = 'tunnelvault_session_key';

// Request header / WebSocket subprotocols carrying the session key (see backend/src/auth.js).
export const SESSION_KEY_HEADER = 'X-TV-Session-Key';
export const SSH_WS_SUBPROTOCOL = 'tunnelvault.v1';
const SSH_WS_KEY_PREFIX = 'tv-key.';
// Server format: 32 random bytes, base64url (43 chars). Anything else is never sent.
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** The stored session key, or null (none, malformed, or storage unavailable). */
export function getSessionKey() {
  let key = null;
  try { key = window.localStorage.getItem(SESSION_KEY_STORAGE_KEY); } catch { return null; }
  return typeof key === 'string' && SESSION_KEY_RE.test(key) ? key : null;
}

function storeSessionKey(key) {
  if (typeof key !== 'string' || !SESSION_KEY_RE.test(key)) {
    clearSessionKey();
    return;
  }
  try { window.localStorage.setItem(SESSION_KEY_STORAGE_KEY, key); } catch { /* storage unavailable */ }
}

/** Forget the session key (logout, 401, legacy cleanup). */
export function clearSessionKey() {
  try { window.localStorage.removeItem(SESSION_KEY_STORAGE_KEY); } catch { /* storage unavailable */ }
}

/** Remove the admin token that older dashboard versions left in browser storage. */
export function purgeLegacyAuthToken() {
  try { window.localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch { /* storage unavailable */ }
  try { window.sessionStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch { /* storage unavailable */ }
  // Companion cleanup: drop a malformed/tampered session key (it would never be sent anyway).
  if (!getSessionKey()) clearSessionKey();
}

export class ApiError extends Error {
  /**
   * @param {string} message human readable message (safe to show in the UI)
   * @param {{ status?: number, data?: any }} [info] status 0 = network error
   */
  constructor(message, { status = 0, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function describeStatus(status) {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'The server refused this request (HTTP 403).';
  if (status === 404) return 'Not found (HTTP 404).';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return `The server reported an error (HTTP ${status}).`;
  return `Request failed (HTTP ${status}).`;
}

/**
 * Human readable message from an error body. Most routes answer {error: '<message>'};
 * auth/rate-limit responses answer {error: '<short label>', message: '<explanation>'},
 * in which case the explanation is the more useful text.
 */
function serverErrorMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const error = typeof data.error === 'string' ? data.error.trim() : '';
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  const msg = message || error;
  if (!msg) return null;
  return msg.length > MAX_ERROR_MESSAGE_LENGTH ? msg.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '…' : msg;
}

/**
 * Perform an API request. Resolves with the parsed JSON body (or null for an
 * empty body, e.g. 204). Rejects with ApiError for network errors (status 0),
 * non-2xx responses (message taken from the server's {error} when present) and
 * non-JSON success bodies.
 */
export async function apiFetch(path, { method = 'GET', body, signal, notifyUnauthorized = true } = {}) {
  const headers = { Accept: 'application/json' };
  const sessionKey = getSessionKey();
  if (sessionKey) headers[SESSION_KEY_HEADER] = sessionKey;
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store', signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server. Check your connection and try again.', { status: 0 });
  }

  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let data = null;
  let parsed = false;
  if (text) {
    try { data = JSON.parse(text); parsed = true; } catch { data = null; }
  }

  if (!res.ok) {
    if (res.status === 401) {
      // The session (cookie + key) is no longer valid: the key is useless from now on.
      clearSessionKey();
      if (notifyUnauthorized) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    // 401: always the generic "session expired" text (the UI returns to the login screen).
    const message = res.status === 401 ? describeStatus(401) : serverErrorMessage(data) || describeStatus(res.status);
    throw new ApiError(message, { status: res.status, data });
  }
  if (text && !parsed) {
    throw new ApiError('Unexpected response from the server.', { status: res.status });
  }
  return data;
}

function listFrom(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  return [];
}

const enc = encodeURIComponent;

// ── Auth ──

/**
 * GET /api/auth/session -> { authenticated: bool, authRequired: bool }
 * When auth is required, a session without a stored session key counts as logged
 * out (e.g. a cookie from a dashboard version before session keys): the user signs
 * in once more and receives a key.
 */
export async function getSession() {
  const data = await apiFetch('/api/auth/session', { notifyUnauthorized: false });
  if (!data || typeof data.authenticated !== 'boolean') {
    throw new ApiError('Unexpected response from the server.', { status: 200 });
  }
  const authRequired = data.authRequired !== false;
  const authenticated = data.authenticated && (!authRequired || getSessionKey() !== null);
  return { authenticated, authRequired };
}

/**
 * POST /api/auth/login — the server answers with an HttpOnly session cookie and
 * {sessionKey}, which is stored for this origin and sent with every later request.
 */
export async function login(token) {
  clearSessionKey();
  const data = await apiFetch('/api/auth/login', { method: 'POST', body: { token }, notifyUnauthorized: false });
  storeSessionKey(data && data.sessionKey);
  return data;
}

/** POST /api/auth/logout — ends the session server side (needs the key) and forgets the key. */
export async function logout() {
  clearConfigCache();
  try {
    return await apiFetch('/api/auth/logout', { method: 'POST', notifyUnauthorized: false });
  } finally {
    clearSessionKey();
  }
}

// ── Server config ──

let configPromise = null;

/** GET /api/config (cached for the lifetime of the page; failures are not cached). */
export function getConfig({ force = false } = {}) {
  if (force || !configPromise) {
    const p = apiFetch('/api/config');
    configPromise = p;
    p.catch(() => { if (configPromise === p) configPromise = null; });
  }
  return configPromise;
}

export function clearConfigCache() {
  configPromise = null;
}

// ── Stats ──

function formatBytes(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}

function formatActivityTime(ts) {
  if (!ts || typeof ts !== 'string') return '–';
  const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export async function getStats() {
  const data = (await apiFetch('/api/stats')) || {};

  const chartData = (Array.isArray(data.connectionHistory) ? data.connectionHistory : []).map((p) => ({
    time: new Date(p.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    connections: p.count,
  }));

  const recentActivity = (Array.isArray(data.recent_sessions) ? data.recent_sessions : []).slice(0, 8).map((s, idx) => ({
    id: s.id ?? idx,
    type: s.disconnected_at ? 'session_ended' : 'session_started',
    message: `${s.token_label || s.tunnel_name || s.token || 'unknown'} ${s.disconnected_at ? 'disconnected' : 'connected'} from ${s.client_ip || 'unknown'}`,
    time: formatActivityTime(s.disconnected_at || s.connected_at),
  }));

  return {
    activeTunnels: data.activeTunnels ?? 0,
    activeConnections: data.activeConnections ?? 0,
    totalConnections: data.totalConnections ?? 0,
    dataTransferred: formatBytes(Number(data.bytesTransferred) || 0),
    uptime: data.uptime || '0s',
    activeTokens: data.active_tokens ?? 0,
    liveSessions: data.live_sessions ?? 0,
    chartData,
    recentActivity,
  };
}

// ── Tunnels ──

export async function getTunnels() {
  return listFrom(await apiFetch('/api/tunnels'), 'tunnels');
}

export function deleteTunnel(id) {
  return apiFetch(`/api/tunnels/${enc(id)}`, { method: 'DELETE' });
}

export function toggleTunnel(id) {
  return apiFetch(`/api/tunnels/${enc(id)}/toggle`, { method: 'POST' });
}

export function rebootTunnel(id) {
  return apiFetch(`/api/tunnels/${enc(id)}/reboot`, { method: 'POST' });
}

/** Forget the pinned SSH host key of a tunnel (next web-terminal connect re-verifies). */
export function forgetHostKey(id) {
  return apiFetch(`/api/tunnels/${enc(id)}/hostkey`, { method: 'DELETE' });
}

export async function getConnections() {
  return listFrom(await apiFetch('/api/connections'), 'connections');
}

// ── Device tokens ──

export async function getTokens() {
  return listFrom(await apiFetch('/api/tokens'), 'tokens');
}

export function createToken(tokenData) {
  return apiFetch('/api/tokens', { method: 'POST', body: tokenData });
}

export function getTokenDetail(token) {
  return apiFetch(`/api/tokens/${enc(token)}`);
}

export function updateToken(token, updates) {
  return apiFetch(`/api/tokens/${enc(token)}`, { method: 'PATCH', body: updates });
}

/** Store (PEM string) or clear ('') the token's SSH private key for the web terminal. */
export function setTokenPrivateKey(token, privateKey) {
  return updateToken(token, { private_key: privateKey });
}

export function deleteToken(token) {
  return apiFetch(`/api/tokens/${enc(token)}`, { method: 'DELETE' });
}

// ── Sessions ──

export async function getSessions(activeOnly = false) {
  return listFrom(await apiFetch(activeOnly ? '/api/sessions?active=1' : '/api/sessions'), 'sessions');
}

// ── Web SSH terminal ──

/** WebSocket URL of the browser SSH terminal (no credentials in the URL). */
export function getSshWsUrl(tunnelId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ tunnelId: String(tunnelId) });
  return `${proto}://${window.location.host}/ws/ssh?${params.toString()}`;
}

/**
 * Subprotocols offered on /ws/ssh: ['tunnelvault.v1', 'tv-key.<sessionKey>'].
 * The server selects 'tunnelvault.v1' and never echoes the key entry.
 * Without a stored key only 'tunnelvault.v1' is offered (servers without AUTH_TOKEN).
 */
export function sshWsProtocols() {
  const key = getSessionKey();
  return key ? [SSH_WS_SUBPROTOCOL, SSH_WS_KEY_PREFIX + key] : [SSH_WS_SUBPROTOCOL];
}

/**
 * Open the browser SSH terminal socket, authenticated by the session cookie plus
 * the session key (subprotocol). Throws ApiError(401) when auth is required and
 * no session key is stored, so the caller can send the user back to login.
 * @param {string} tunnelId
 * @param {{ authRequired?: boolean }} [opts]
 */
export function openSshSocket(tunnelId, { authRequired = true } = {}) {
  if (authRequired && !getSessionKey()) {
    throw new ApiError(describeStatus(401), { status: 401 });
  }
  return new WebSocket(getSshWsUrl(tunnelId), sshWsProtocols());
}
