const EMPTY_STATS = {
  activeTunnels: 0,
  activeConnections: 0,
  totalConnections: 0,
  dataTransferred: '0 B',
  uptime: '0s',
  activeTokens: 0,
  liveSessions: 0,
  chartData: [],
  recentActivity: [],
};

// ── Auth helpers ──
export function getAuthToken() {
  return localStorage.getItem('tunnelvault_auth_token') || '';
}

export function setAuthToken(token) {
  localStorage.setItem('tunnelvault_auth_token', token);
}

export function clearAuthToken() {
  localStorage.removeItem('tunnelvault_auth_token');
}

async function request(url, options = {}) {
  try {
    const authToken = getAuthToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      // Return special error so UI can show login prompt
      return { __unauthorized: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

export function isUnauthorized(data) {
  return data && data.__unauthorized === true;
}

// ── Tunnel endpoints ──

export async function getStats() {
  const data = await request('/api/stats');
  if (!data || isUnauthorized(data)) return EMPTY_STATS;

  // Normalize real API response to match frontend expectations
  const bytes = data.bytesTransferred || 0;
  let dataTransferred;
  if (bytes > 1e9) dataTransferred = (bytes / 1e9).toFixed(2) + ' GB';
  else if (bytes > 1e6) dataTransferred = (bytes / 1e6).toFixed(1) + ' MB';
  else if (bytes > 1e3) dataTransferred = (bytes / 1e3).toFixed(0) + ' KB';
  else dataTransferred = bytes + ' B';

  const chartData = (data.connectionHistory || []).map((p) => ({
    time: new Date(p.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    connections: p.count,
  }));

  // Build recent activity from recent sessions
  const recentActivity = (data.recent_sessions || []).slice(0, 8).map((s, idx) => ({
    id: s.id || idx,
    type: s.disconnected_at ? 'session_ended' : 'session_started',
    message: `${s.token_label || s.token || 'unknown'} ${s.disconnected_at ? 'disconnected' : 'connected'} from ${s.client_ip || 'unknown'}`,
    time: s.disconnected_at
      ? new Date(s.disconnected_at.endsWith('Z') ? s.disconnected_at : s.disconnected_at + 'Z').toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : new Date(s.connected_at.endsWith('Z') ? s.connected_at : s.connected_at + 'Z').toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
  }));

  return {
    activeTunnels: data.activeTunnels ?? 0,
    activeConnections: data.activeConnections ?? 0,
    totalConnections: data.totalConnections ?? 0,
    dataTransferred,
    uptime: data.uptime || '0s',
    activeTokens: data.active_tokens ?? 0,
    liveSessions: data.live_sessions ?? 0,
    chartData,
    recentActivity,
  };
}

export async function getTunnels() {
  const data = await request('/api/tunnels');
  if (data && !isUnauthorized(data)) {
    const tunnels = Array.isArray(data) ? data : data.tunnels || [];
    return tunnels;
  }
  return [];
}

export async function createTunnel(tunnel) {
  const data = await request('/api/tunnels', {
    method: 'POST',
    body: JSON.stringify(tunnel),
  });
  return data || null;
}

export async function deleteTunnel(id) {
  const data = await request(`/api/tunnels/${id}`, { method: 'DELETE' });
  return data || null;
}

export async function toggleTunnel(id) {
  const data = await request(`/api/tunnels/${id}/toggle`, { method: 'POST' });
  return data || null;
}

export async function rebootTunnel(id) {
  const data = await request(`/api/tunnels/${id}/reboot`, { method: 'POST' });
  return data || null;
}

export async function getConnections() {
  const data = await request('/api/connections');
  if (data && !isUnauthorized(data)) {
    const connections = Array.isArray(data) ? data : data.connections || [];
    return connections;
  }
  return [];
}

// ── SSH Token endpoints ──

export async function getTokens() {
  const data = await request('/api/tokens');
  if (data && !isUnauthorized(data)) {
    const tokens = Array.isArray(data) ? data : data.tokens || [];
    return tokens;
  }
  return [];
}

export async function createToken(tokenData) {
  const data = await request('/api/tokens', {
    method: 'POST',
    body: JSON.stringify(tokenData),
  });
  return data || null;
}

export async function getTokenDetail(token) {
  const data = await request(`/api/tokens/${token}`);
  return data || null;
}

export async function updateToken(token, updates) {
  const data = await request(`/api/tokens/${token}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  return data || null;
}

export async function deleteToken(token) {
  const data = await request(`/api/tokens/${token}`, { method: 'DELETE' });
  return data || null;
}

// ── SSH Session endpoints ──

// ── SSH WebSocket URL ──

export function getSshWsUrl(tunnelId) {
  const token = getAuthToken();
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.host;
  const params = new URLSearchParams({ tunnelId });
  if (token) params.set('auth_token', token);
  return `${proto}://${host}/ws/ssh?${params.toString()}`;
}

export async function getSessions(activeOnly = false) {
  const url = activeOnly ? '/api/sessions?active=1' : '/api/sessions';
  const data = await request(url);
  if (data && !isUnauthorized(data)) {
    // API returns {sessions: [...]} — unwrap if needed
    const sessions = Array.isArray(data) ? data : data.sessions || [];
    return sessions;
  }
  return [];
}
