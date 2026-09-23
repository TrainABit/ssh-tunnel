/**
 * TunnelVault dashboard API client.
 *
 * Authentication is cookie based: POST /api/auth/login sets an HttpOnly session
 * cookie and every request below is sent with `credentials: 'same-origin'`.
 * The admin AUTH_TOKEN is never stored in the browser (no localStorage, no
 * query strings). A 401 from any endpoint dispatches UNAUTHORIZED_EVENT so the
 * AuthGate can send the user back to the login screen.
 */

// Key used by old dashboard versions to persist the admin token in localStorage.
export const LEGACY_AUTH_TOKEN_KEY = 'tunnelvault_auth_token';

// Fired on window whenever the API answers 401 (session expired / logged out).
export const UNAUTHORIZED_EVENT = 'tunnelvault:unauthorized';

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Remove the admin token that older dashboard versions left in browser storage. */
export function purgeLegacyAuthToken() {
  try { window.localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch { /* storage unavailable */ }
  try { window.sessionStorage.removeItem(LEGACY_AUTH_TOKEN_KEY); } catch { /* storage unavailable */ }
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

function serverErrorMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const msg = typeof data.error === 'string' ? data.error
    : typeof data.message === 'string' ? data.message
    : null;
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
    if (res.status === 401 && notifyUnauthorized) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(serverErrorMessage(data) || describeStatus(res.status), { status: res.status, data });
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

/** GET /api/auth/session -> { authenticated: bool, authRequired: bool } */
export async function getSession() {
  const data = await apiFetch('/api/auth/session', { notifyUnauthorized: false });
  if (!data || typeof data.authenticated !== 'boolean') {
    throw new ApiError('Unexpected response from the server.', { status: 200 });
  }
  return { authenticated: data.authenticated, authRequired: data.authRequired !== false };
}

/** POST /api/auth/login — the server answers with an HttpOnly session cookie. */
export async function login(token) {
  return apiFetch('/api/auth/login', { method: 'POST', body: { token }, notifyUnauthorized: false });
}

/** POST /api/auth/logout — clears the session cookie server side. */
export async function logout() {
  clearConfigCache();
  return apiFetch('/api/auth/logout', { method: 'POST', notifyUnauthorized: false });
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

/** WebSocket URL of the browser SSH terminal. Authenticated by the session cookie. */
export function getSshWsUrl(tunnelId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ tunnelId: String(tunnelId) });
  return `${proto}://${window.location.host}/ws/ssh?${params.toString()}`;
}
