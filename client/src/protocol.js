/**
 * TunnelVault device wire protocol helpers (protocol v2, see docs/PROTOCOL.md).
 *
 * Text frames carry JSON control messages. In protocol v2, tunnel payload travels in
 * binary DATA frames:  byte 0 = 0x01, bytes 1..16 = connId (UUID as 16 raw bytes),
 * rest = payload. Legacy v1 peers use JSON `tcp-data {connId, data: base64}` instead.
 */
import net from 'node:net';

export const CLIENT_VERSION = '2.0.0';

export const PROTOCOL_VERSION = 2;
export const PROTOCOL_HEADER = 'X-TunnelVault-Protocol';

export const FRAME_DATA = 0x01;
export const CONN_ID_LENGTH = 16;
export const FRAME_HEADER_LENGTH = 1 + CONN_ID_LENGTH;

/** Senders never exceed this payload size per frame (binary DATA or legacy tcp-data). */
export const MAX_FRAME_PAYLOAD = 256 * 1024;
/** Raw bytes per legacy JSON tcp-data message (base64 of this stays <= MAX_FRAME_PAYLOAD). */
export const MAX_LEGACY_CHUNK = 192 * 1024;

/** Stop reading local sockets while ws.bufferedAmount is above this ... */
export const WS_HIGH_WATER_MARK = 8 * 1024 * 1024;
/** ... and resume once it dropped below this. */
export const WS_LOW_WATER_MARK = 1 * 1024 * 1024;

export const CLOSE_TOKEN_REVOKED = 4000;
export const CLOSE_PROTOCOL_VIOLATION = 4001;
export const CLOSE_SUPERSEDED = 4003;

export const ERROR_TUNNEL_NOT_FOUND = 'TUNNEL_NOT_FOUND';
/** Message text old servers send (no code / tunnelId) when a reconnect fails. */
export const LEGACY_TUNNEL_NOT_FOUND_MESSAGE = 'Tunnel not found for reconnect';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Canonical form of a connection id received from the peer: UUIDs are lower-cased
 * (binary frames always decode to lower case); other ids (legacy peers) are kept
 * verbatim if they are short printable strings. Returns null for anything else.
 */
export function normalizeConnId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (UUID_RE.test(value)) return value.toLowerCase();
  CONTROL_CHARS_RE.lastIndex = 0;
  if (CONTROL_CHARS_RE.test(value)) return null;
  return value;
}

export function uuidToBytes(uuid) {
  if (!isUuid(uuid)) throw new TypeError('connId must be a UUID');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function bytesToUuid(buf, offset = 0) {
  const hex = buf.toString('hex', offset, offset + CONN_ID_LENGTH);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Build a binary DATA frame. `payload` must not exceed MAX_FRAME_PAYLOAD (callers split). */
export function encodeDataFrame(connId, payload) {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_LENGTH + payload.length);
  frame[0] = FRAME_DATA;
  uuidToBytes(connId).copy(frame, 1);
  payload.copy(frame, FRAME_HEADER_LENGTH);
  return frame;
}

/**
 * Decode a binary frame. Returns null for frames shorter than the header;
 * otherwise { type, connId, payload } (callers ignore types they do not know).
 * `payload` is a view into `buf` (no copy).
 */
export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEADER_LENGTH) return null;
  return {
    type: buf[0],
    connId: bytesToUuid(buf, 1),
    payload: buf.subarray(FRAME_HEADER_LENGTH),
  };
}

/**
 * Make a server-supplied value safe to print on a terminal / in a log line:
 * strips control characters (incl. ANSI escape introducers) and caps the length.
 */
export function sanitizeText(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  let s = String(value).replace(CONTROL_CHARS_RE, '');
  if (s.length > maxLength) s = `${s.slice(0, maxLength)}…`;
  return s;
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 // loopback
    || p[0] === 10 // RFC 1918
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) // RFC 1918
    || (p[0] === 192 && p[1] === 168) // RFC 1918
    || (p[0] === 169 && p[1] === 254) // link-local
    || (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0);
}

const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'];

/**
 * True when `hostname` is loopback, RFC 1918 / ULA / link-local or a local-only name,
 * i.e. traffic to it does not cross the public internet.
 */
export function isLocalOrPrivateHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || LOCAL_NAME_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const family = net.isIP(h);
  if (family === 4) return isPrivateIPv4(h);
  if (family === 6) {
    if (h === '::1') return true;
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(h.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

/**
 * Normalise the configured server URL to the device WebSocket endpoint.
 * Accepts ws://, wss://, http:// and https:// (mapped to ws/wss) and appends `/ws`
 * unless the path already ends with it. Throws TypeError for anything else.
 * Returns { url, tokenFromQuery } — a legacy `?auth_token=` value is removed from
 * the URL (it would leak into server/proxy logs) and handed back separately.
 */
export function buildWsUrl(serverUrl) {
  let u;
  try {
    u = new URL(String(serverUrl));
  } catch {
    throw new TypeError(`Invalid server URL: ${sanitizeText(serverUrl, 100)}`);
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new TypeError(`Server URL must start with ws:// or wss:// (got ${sanitizeText(u.protocol, 20)})`);
  }
  if (u.username || u.password) {
    throw new TypeError('Server URL must not contain credentials; use --auth-token / TUNNELVAULT_AUTH_TOKEN');
  }
  u.hash = '';
  const tokenFromQuery = u.searchParams.get('auth_token') || null;
  if (u.searchParams.has('auth_token')) u.searchParams.delete('auth_token');
  if (!/\/ws\/?$/.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  } else {
    u.pathname = u.pathname.replace(/\/$/, '');
  }
  return { url: u.toString(), tokenFromQuery };
}

/** True for a plaintext (ws://) URL whose host is not local/private. */
export function isInsecureRemoteUrl(wsUrl) {
  let u;
  try {
    u = new URL(wsUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'http:') return false;
  return !isLocalOrPrivateHost(u.hostname);
}
