import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync, statSync, lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { Display } from './display.js';
import {
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  FRAME_DATA,
  MAX_FRAME_PAYLOAD,
  MAX_LEGACY_CHUNK,
  WS_HIGH_WATER_MARK,
  WS_LOW_WATER_MARK,
  CLOSE_TOKEN_REVOKED,
  CLOSE_PROTOCOL_VIOLATION,
  CLOSE_SUPERSEDED,
  ERROR_TUNNEL_NOT_FOUND,
  LEGACY_TUNNEL_NOT_FOUND_MESSAGE,
  buildWsUrl,
  decodeFrame,
  encodeDataFrame,
  isInsecureRemoteUrl,
  isUuid,
  normalizeConnId,
  sanitizeText,
} from './protocol.js';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
// The reconnect backoff starts over only after a connection stayed up this long, so a
// server that accepts and immediately drops us is not hammered once per second.
const STABLE_CONNECTION_MS = 10000;
const HEARTBEAT_TIMEOUT = 35000;
// The client pings the server this often (the server pings every 30 s as well), so a
// healthy connection always has recent traffic well inside HEARTBEAT_TIMEOUT.
const PING_INTERVAL = 15000;
const HANDSHAKE_TIMEOUT = 15000;
const REBOOT_DELAY = 500;
// A connection the server closed while keeping us paused is given up after this long.
const HALF_CLOSE_STALL_TIMEOUT = 5 * 60 * 1000;

// Largest message accepted from the server. v2 servers never exceed 256 KiB per frame;
// the headroom is for legacy `request` messages (old servers accept 10 MB bodies, base64).
const MAX_INCOMING_MESSAGE = 16 * 1024 * 1024;

// Local socket write buffering: socket.write() returns false (-> tcp-pause) above this ...
const LOCAL_WRITE_HIGH_WATER = 1024 * 1024;
// ... and a peer that keeps sending anyway (v1 servers have no flow control) gets the
// connection closed instead of growing this process without bound.
const LOCAL_WRITE_HARD_LIMIT = 64 * 1024 * 1024;

// Legacy (v1) HTTP request/response proxying. Old servers reject WS messages > 1 MiB,
// so a bigger response would kill the whole connection: answer 502 instead.
const LEGACY_MAX_RESPONSE_BYTES = 700 * 1024;
const LEGACY_REQUEST_TIMEOUT = 30000;
const LEGACY_HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
  'transfer-encoding', 'content-length', 'http2-settings',
]);

const WARN_BURST = 20;
const WARN_WINDOW_MS = 60000;

const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;

/** Directory holding state.json: $TUNNELVAULT_STATE_DIR or ~/.tunnelvault. */
export function defaultStateDir(env = process.env) {
  return env.TUNNELVAULT_STATE_DIR || join(homedir(), '.tunnelvault');
}

/**
 * Remote reboot is opt-in. TUNNELVAULT_ALLOW_REBOOT (1/true/yes/on or 0/false/no/off)
 * wins when set; otherwise config.json `"allow_reboot": true` enables it.
 */
export function resolveAllowReboot(config, env = process.env) {
  const raw = env.TUNNELVAULT_ALLOW_REBOOT;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const v = raw.trim();
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
  }
  return Boolean(config && config.allow_reboot === true);
}

/** Tunnel ids are UUIDs; servers may differ in letter case. */
function sameTunnelId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function normalizeTunnels(options) {
  const multi = Array.isArray(options.tunnels) && options.tunnels.length > 0;
  const raw = multi
    ? options.tunnels
    : [{ port: options.port, protocol: options.protocol || 'http', name: options.name || '', subdomain: options.subdomain }];
  const tunnels = [];
  const duplicatePorts = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') throw new TypeError('Invalid tunnel entry in configuration');
    const port = validPort(t.port);
    if (port === null) throw new TypeError(`Invalid tunnel port: ${sanitizeText(t.port, 20)} (must be 1-65535)`);
    const protocol = String(t.protocol || 'tcp').toLowerCase();
    if (protocol !== 'tcp' && protocol !== 'http') {
      throw new TypeError(`Invalid protocol for port ${port}: ${sanitizeText(t.protocol, 20)} (use tcp or http)`);
    }
    if (tunnels.some((x) => x.port === port)) {
      duplicatePorts.push(port);
      continue;
    }
    const fallbackName = multi ? `tunnel-${port}` : '';
    tunnels.push({
      port,
      protocol,
      name: t.name ? String(t.name).slice(0, 100) : fallbackName,
      subdomain: t.subdomain ? String(t.subdomain).slice(0, 63) : '',
    });
  }
  return { tunnels, duplicatePorts };
}

function legacyRequestHeaders(headers, body) {
  const out = {};
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      const k = key.toLowerCase();
      if (LEGACY_HOP_BY_HOP.has(k)) continue;
      if (typeof value === 'string') out[k] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[k] = value;
    }
  }
  if (body) out['content-length'] = String(body.length);
  return out;
}

/**
 * Device-side tunnel client.
 *
 * options:
 *   server        ws(s):// URL of the TunnelVault server (http(s):// accepted)
 *   authToken     device or admin token (sent as `Authorization: Bearer`)
 *   tunnels       [{port, protocol: 'tcp'|'http', name?, subdomain?}]  (or legacy port/protocol/name/subdomain)
 *   allowReboot   honour the server's `reboot` message (default false)
 *   display       UI object (default: new Display()); see QuietDisplay for the interface
 *   exec          execFile-compatible function used for reboot (default: child_process.execFile)
 *   stateDir      directory for state.json (default: $TUNNELVAULT_STATE_DIR or ~/.tunnelvault)
 *   localHost     host local services listen on (default 'localhost')
 *   runAsRoot     reboot without sudo (default: process runs as uid 0)
 *   reconnectDelayMs / maxReconnectDelayMs / stableConnectionMs / heartbeatTimeoutMs / pingIntervalMs / rebootDelayMs /
 *   halfCloseStallMs / wsHighWaterMark / wsLowWaterMark   tuning knobs (mainly for tests)
 *
 * The constructor throws TypeError on invalid configuration; the class never exits the process.
 */
export class TunnelClient {
  constructor(options = {}) {
    this.display = options.display || new Display();

    const { tunnels, duplicatePorts } = normalizeTunnels(options);
    this.tunnels = tunnels;
    this.tunnelPorts = new Set(tunnels.map((t) => t.port));

    this.serverUrl = options.server || 'ws://localhost:4000';
    const { url, tokenFromQuery } = buildWsUrl(this.serverUrl);
    this.wsUrl = url;
    this.authToken = options.authToken || tokenFromQuery || '';
    if (this.authToken && !TOKEN_RE.test(this.authToken)) {
      throw new TypeError('Invalid auth token (expected printable ASCII without spaces)');
    }

    this.startupWarnings = [];
    for (const port of duplicatePorts) {
      this.startupWarnings.push(`Port ${port} is configured more than once; only the first entry is used`);
    }
    if (tokenFromQuery) {
      this.startupWarnings.push('The server URL contains ?auth_token=...; it was removed from the URL and sent as a Bearer header instead. Please remove it from your configuration.');
    }

    this.allowReboot = options.allowReboot === true;
    this.exec = typeof options.exec === 'function' ? options.exec : execFile;
    this.runAsRoot = typeof options.runAsRoot === 'boolean'
      ? options.runAsRoot
      : typeof process.getuid === 'function' && process.getuid() === 0;
    this.stateDir = options.stateDir || defaultStateDir();
    this.stateFile = join(this.stateDir, 'state.json');
    this.localHost = options.localHost || 'localhost';

    this.initialReconnectDelay = options.reconnectDelayMs ?? INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY;
    this.stableConnectionMs = options.stableConnectionMs ?? STABLE_CONNECTION_MS;
    this.heartbeatTimeout = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT;
    this.pingInterval = options.pingIntervalMs ?? PING_INTERVAL;
    this.rebootDelay = options.rebootDelayMs ?? REBOOT_DELAY;
    this.halfCloseStallMs = options.halfCloseStallMs ?? HALF_CLOSE_STALL_TIMEOUT;
    this.wsHighWater = options.wsHighWaterMark ?? WS_HIGH_WATER_MARK;
    this.wsLowWater = options.wsLowWaterMark ?? WS_LOW_WATER_MARK;

    this.ws = null;
    this.reconnectDelay = this.initialReconnectDelay;
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.rebootTimer = null;
    this.rebootPending = false;
    this.lastActivity = 0;
    this.openedAt = 0;
    this.upgradeStatus = null;
    this.conns = new Map(); // connId -> conn (see _openLocal)

    this.warnWindowStart = 0;
    this.warnCount = 0;
    this.warnSuppressed = 0;

    this._onSendDone = (err) => {
      if (!err) this._maybeUncongest();
    };

    this._resetSessionState();

    // Per-tunnel state keyed by local port: { tunnelId, ownerSecret, publicUrl, allocatedPort }
    this.stateByPort = this._loadState();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connect() {
    if (this.ws || this.reconnectTimer) return; // already connecting / connected
    this.shouldReconnect = true;
    for (const w of this.startupWarnings) this.display.warn(w);
    if (isInsecureRemoteUrl(this.wsUrl)) {
      this.display.warn(
        `Server ${sanitizeText(new URL(this.wsUrl).host, 100)} is reached over unencrypted ws://: the auth token and all `
        + 'tunnel traffic cross the network in plaintext. Use a wss:// server URL (install the server with --tls).',
      );
    }
    this.display.startSpinner(`Connecting to ${this.wsUrl}...`);
    this._doConnect();
  }

  /** Stop the client. Resolves once the WebSocket is closed (at most ~2 s). */
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.rebootTimer) {
      clearTimeout(this.rebootTimer);
      this.rebootTimer = null;
    }
    this._clearHeartbeat();
    this._destroyAllConns();
    this.display.destroy();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* already gone */ }
        resolve();
      }, 2000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, 'Client disconnecting');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  _resetSessionState() {
    this.peerVersion = 1;
    this.useBinary = false; // v2 binary DATA frames (only after hello)
    this.useFlowControl = false; // v2 tcp-pause / tcp-resume (only after hello)
    this.helloSeen = false;
    this.streamsSeen = false; // a tcp-open arrived on this connection
    this.wsCongested = false;
    this.pendingReconnects = new Map(); // tunnelId -> port, reconnects awaiting a reply
    this.unattributedNotFound = 0; // TUNNEL_NOT_FOUND errors without tunnelId (old servers)
    this.liveTunnels = new Set(); // ports registered/reconnected on this connection
    this.pausedTunnels = new Set(); // ports the server put in standby
    this.tunnelErrors = new Map(); // port -> last registration error
  }

  _doConnect() {
    this._resetSessionState();
    this.upgradeStatus = null;
    const headers = {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      'User-Agent': `tunnelvault-client/${CLIENT_VERSION}`,
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    let ws;
    try {
      ws = new WebSocket(this.wsUrl, {
        headers,
        perMessageDeflate: false,
        maxPayload: MAX_INCOMING_MESSAGE,
        handshakeTimeout: HANDSHAKE_TIMEOUT,
        followRedirects: false,
      });
    } catch (err) {
      this.display.stopSpinner(false, `Failed to connect: ${sanitizeText(err.message)}`);
      this._scheduleReconnect(false);
      return;
    }
    this.ws = ws;

    ws.on('open', () => this._onOpen(ws));
    ws.on('message', (data, isBinary) => this._onMessage(ws, data, isBinary));
    ws.on('ping', () => { if (ws === this.ws) this._touch(); });
    ws.on('pong', () => { if (ws === this.ws) this._touch(); });
    ws.on('close', (code, reason) => this._onClose(ws, code, reason));
    ws.on('error', (err) => this._onError(ws, err));
  }

  _onOpen(ws) {
    if (ws !== this.ws) return;
    this.openedAt = Date.now();
    this._touch();
    this._startHeartbeat(ws);
    this._updateDisplay();

    // Register or reconnect each tunnel
    for (const t of this.tunnels) {
      const saved = this.stateByPort[t.port];
      // Servers only know UUID tunnel ids (a v2 server rejects anything else as an invalid
      // message, which would leave the tunnel unregistered): register such entries afresh.
      if (isUuid(saved?.tunnelId) && saved?.ownerSecret) {
        this.pendingReconnects.set(saved.tunnelId.toLowerCase(), t.port);
        this._sendJson(ws, { type: 'reconnect', tunnelId: saved.tunnelId, ownerSecret: saved.ownerSecret });
      } else {
        this._sendRegister(t);
      }
    }
  }

  _onError(ws, err) {
    if (ws !== this.ws) return;
    const m = /Unexpected server response: (\d{3})/.exec(err?.message || '');
    if (m) this.upgradeStatus = Number(m[1]);
    if (this.upgradeStatus === 401) return; // reported (once, clearly) by _onClose
    this.display.stopSpinner(false, `Connection error: ${sanitizeText(err?.message)}`);
  }

  _onClose(ws, code, reason) {
    if (ws !== this.ws) return;
    this._clearHeartbeat();
    this._destroyAllConns();
    this.ws = null;
    this.wsCongested = false;
    if (this.openedAt && Date.now() - this.openedAt >= this.stableConnectionMs) {
      this.reconnectDelay = this.initialReconnectDelay;
      this.reconnectAttempt = 0;
    }
    this.openedAt = 0;

    const reasonText = sanitizeText(reason ? reason.toString() : '', 120);
    const retryIn = `${Math.round(this.maxReconnectDelay / 1000)}s`;
    let forceMax = false;
    if (code === CLOSE_TOKEN_REVOKED || this.upgradeStatus === 401) {
      this.display.error(
        `Server rejected the connection: token revoked or invalid (check TUNNELVAULT_AUTH_TOKEN). Retrying every ${retryIn}.`,
      );
      forceMax = true;
    } else if (code === CLOSE_SUPERSEDED) {
      this.display.warn(
        `Connection superseded by a newer connection using the same token (is another client running with it?). Retrying in ${retryIn}.`,
      );
      forceMax = true;
    } else if (this.upgradeStatus === 429) {
      this.display.warn(`Server is rate limiting connection attempts. Retrying in ${retryIn}.`);
      forceMax = true;
    } else if (code === CLOSE_PROTOCOL_VIOLATION) {
      this.display.error(`Server closed the connection: protocol violation${reasonText ? ` (${reasonText})` : ''}`);
    }

    const shown = this.upgradeStatus ? `HTTP ${this.upgradeStatus}` : (reasonText || `code ${code}`);
    this.display.setDisconnected(shown);
    this._scheduleReconnect(forceMax);
  }

  _scheduleReconnect(forceMax) {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    if (forceMax) this.reconnectDelay = this.maxReconnectDelay;
    this.reconnectAttempt++;
    // Up to 20 % jitter (downwards) so a fleet of devices does not reconnect in lockstep.
    const delay = Math.max(1, Math.round(this.reconnectDelay * (0.8 + Math.random() * 0.2)));
    this.display.setReconnecting(this.reconnectAttempt, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      this.display.startSpinner(`Reconnecting (attempt ${this.reconnectAttempt})...`);
      this._doConnect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _touch() {
    this.lastActivity = Date.now();
  }

  /**
   * Liveness: anything received from the server (messages, pings, pongs) counts. We ping
   * the server every pingInterval (it answers with a pong) and drop the connection when
   * nothing arrived for heartbeatTimeout — a half-open TCP connection is never noticed
   * otherwise and the tunnels would stay dead until the next restart.
   */
  _startHeartbeat(ws) {
    this._clearHeartbeat();
    const tick = () => {
      this.heartbeatTimer = null;
      if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastActivity;
      if (idle >= this.heartbeatTimeout) {
        this.display.warn(`No heartbeat from server for ${Math.round(idle / 1000)}s; reconnecting`);
        ws.terminate();
        return;
      }
      try { ws.ping(); } catch { /* closing */ }
      this.heartbeatTimer = setTimeout(tick, Math.max(1, Math.min(this.pingInterval, this.heartbeatTimeout - idle)));
    };
    this.heartbeatTimer = setTimeout(tick, Math.max(1, Math.min(this.pingInterval, this.heartbeatTimeout)));
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  _sendJson(ws, data) {
    if (!ws || ws !== this.ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(data), this._onSendDone);
    this._checkCongestion(ws);
    return true;
  }

  _sendRegister(t) {
    this.tunnelErrors.delete(t.port);
    this._sendJson(this.ws, {
      type: 'register',
      name: t.name,
      localPort: t.port,
      subdomain: t.subdomain,
      protocol: t.protocol,
    });
  }

  /** Stop reading local sockets while the WebSocket send buffer is above the high-water mark. */
  _checkCongestion(ws) {
    if (this.wsCongested || ws.bufferedAmount <= this.wsHighWater) return;
    this.wsCongested = true;
    for (const conn of this.conns.values()) this._updateReading(conn);
  }

  _maybeUncongest() {
    if (!this.wsCongested) return;
    const ws = this.ws;
    if (ws && ws.bufferedAmount > this.wsLowWater) return;
    this.wsCongested = false;
    for (const conn of this.conns.values()) this._updateReading(conn);
  }

  _updateReading(conn) {
    const shouldPause = conn.pausedByPeer || this.wsCongested;
    if (shouldPause && !conn.readPaused) {
      conn.readPaused = true;
      conn.socket.pause();
    } else if (!shouldPause && conn.readPaused) {
      conn.readPaused = false;
      conn.socket.resume();
    }
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  _onMessage(ws, data, isBinary) {
    if (ws !== this.ws) return;
    this._touch();
    if (isBinary) {
      this._onBinaryFrame(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    try {
      this._handleMessage(msg);
    } catch (err) {
      this.display.error(`Failed to handle '${sanitizeText(msg.type, 32)}' message: ${sanitizeText(err?.message)}`);
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'hello': this._onHello(msg); break;
      case 'registered': this._onRegistered(msg); break;
      case 'reconnected': this._onReconnected(msg); break;
      case 'standby': this._onStandby(msg); break;
      case 'tcp-open': this._onTcpOpen(msg); break;
      case 'tcp-data': this._onLegacyTcpData(msg); break;
      case 'tcp-close': this._onRemoteClose(msg.connId); break;
      case 'tcp-pause': this._onRemotePause(msg.connId, true); break;
      case 'tcp-resume': this._onRemotePause(msg.connId, false); break;
      case 'request': this._handleLegacyRequest(msg); break;
      case 'ping': this._sendJson(this.ws, { type: 'pong' }); break;
      case 'reboot': this._onReboot(); break;
      case 'error': this._onServerError(msg); break;
      default: break; // unknown message types are ignored
    }
  }

  _onHello(msg) {
    // The server greets first. A late or repeated hello must not switch the framing of
    // connections that are already open (legacy ids cannot be encoded in binary frames).
    if (this.helloSeen || this.streamsSeen) return;
    this.helloSeen = true;
    const version = Number(msg.protocolVersion);
    if (!Number.isFinite(version) || version < 2) return;
    const features = Array.isArray(msg.features) ? msg.features : null;
    this.peerVersion = version;
    this.useBinary = !features || features.includes('binary-data');
    this.useFlowControl = !features || features.includes('flow-control');
  }

  _portForTunnelId(tunnelId) {
    if (typeof tunnelId !== 'string' || !tunnelId) return null;
    for (const t of this.tunnels) {
      if (sameTunnelId(this.stateByPort[t.port]?.tunnelId, tunnelId)) return t.port;
    }
    return null;
  }

  _onRegistered(msg) {
    const port = validPort(msg.localPort);
    if (port === null || !this.tunnelPorts.has(port) || typeof msg.tunnelId !== 'string' || !msg.tunnelId) return;
    this.stateByPort[port] = {
      tunnelId: msg.tunnelId.slice(0, 128),
      ownerSecret: typeof msg.ownerSecret === 'string' ? msg.ownerSecret.slice(0, 512) : undefined,
      publicUrl: typeof msg.publicUrl === 'string' ? msg.publicUrl.slice(0, 2048) : undefined,
      allocatedPort: validPort(msg.allocatedPort),
    };
    this.liveTunnels.add(port);
    this.pausedTunnels.delete(port);
    this.tunnelErrors.delete(port);
    this._persistState();
    this._updateDisplay();
  }

  _onReconnected(msg) {
    const port = this._portForTunnelId(msg.tunnelId);
    if (port === null) return;
    this.pendingReconnects.delete(msg.tunnelId.toLowerCase());
    const s = this.stateByPort[port];
    if (typeof msg.publicUrl === 'string') s.publicUrl = msg.publicUrl.slice(0, 2048);
    s.allocatedPort = validPort(msg.allocatedPort);
    this.liveTunnels.add(port);
    this.pausedTunnels.delete(port);
    this.tunnelErrors.delete(port);
    this._persistState();
    this._updateDisplay();
    this._checkUnattributedNotFound();
  }

  _onStandby(msg) {
    const port = this._portForTunnelId(msg.tunnelId);
    if (port === null) {
      this.display.info('Tunnel paused (resume from dashboard)');
      return;
    }
    this.pendingReconnects.delete(msg.tunnelId.toLowerCase());
    this.liveTunnels.delete(port);
    this.pausedTunnels.add(port);
    const t = this.tunnels.find((x) => x.port === port);
    this.display.info(`Tunnel ${sanitizeText(t?.name || port, 60)} (:${port}) is paused (resume from dashboard)`);
    this._updateDisplay();
    this._checkUnattributedNotFound();
  }

  _onServerError(msg) {
    const message = sanitizeText(msg.message, 300);
    const isNotFound = msg.code === ERROR_TUNNEL_NOT_FOUND || msg.message === LEGACY_TUNNEL_NOT_FOUND_MESSAGE;
    if (isNotFound) {
      if (typeof msg.tunnelId === 'string' && msg.tunnelId) {
        this.pendingReconnects.delete(msg.tunnelId.toLowerCase());
        const port = this._portForTunnelId(msg.tunnelId);
        if (port !== null) this._reRegister([port]);
        this._checkUnattributedNotFound();
      } else {
        // Old server: the error does not say which reconnect failed. Every reconnect gets
        // exactly one reply, so once only failures can be outstanding, re-register those.
        this.unattributedNotFound++;
        this._checkUnattributedNotFound();
      }
      return;
    }
    const code = typeof msg.code === 'string' ? ` (${sanitizeText(msg.code, 40)})` : '';
    let port = validPort(msg.localPort);
    if (port === null || !this.tunnelPorts.has(port)) port = this._portForTunnelId(msg.tunnelId);
    if (port !== null) {
      this.tunnelErrors.set(port, message);
      this._updateDisplay();
    }
    this.display.error(`Server error${code}: ${message}`);
  }

  _checkUnattributedNotFound() {
    if (this.unattributedNotFound === 0) return;
    if (this.unattributedNotFound < this.pendingReconnects.size) return; // other replies still due
    const ports = [...this.pendingReconnects.values()];
    this.pendingReconnects.clear();
    this.unattributedNotFound = 0;
    this._reRegister(ports);
  }

  _reRegister(ports) {
    if (ports.length === 0) return;
    for (const port of ports) {
      const t = this.tunnels.find((x) => x.port === port);
      if (!t) continue;
      delete this.stateByPort[port];
      this.liveTunnels.delete(port);
      this.pausedTunnels.delete(port);
      this.display.warn(
        `Tunnel ${sanitizeText(t.name || port, 60)} (:${port}) is unknown to the server; registering it again (its public address may change)`,
      );
      this._sendRegister(t);
    }
    this._persistState();
    this._updateDisplay();
  }

  _onReboot() {
    if (!this.allowReboot) {
      this.display.warn(
        'Ignored remote reboot request from the server: remote reboot is disabled '
        + '(enable with "allow_reboot": true in config.json or TUNNELVAULT_ALLOW_REBOOT=1)',
      );
      return;
    }
    if (this.rebootPending) return;
    this.rebootPending = true;
    this.display.warn('Remote reboot requested by the server; rebooting device…');
    this.display.setDisconnected('rebooting device…');
    // Fixed argv via execFile (no shell). Non-root services need the sudoers rule the
    // installer adds with --allow-reboot; -n makes sudo fail instead of prompting.
    const commands = this.runAsRoot
      ? [['systemctl', ['reboot']], ['reboot', []]]
      : [['sudo', ['-n', 'systemctl', 'reboot']], ['sudo', ['-n', 'reboot']]];
    const attempt = (i) => {
      const [file, args] = commands[i];
      const done = (err) => {
        if (!err) return;
        if (i + 1 < commands.length) {
          attempt(i + 1);
          return;
        }
        this.rebootPending = false;
        this.display.error(`Remote reboot failed: ${sanitizeText(err.message)}`);
      };
      try {
        this.exec(file, args, done);
      } catch (err) {
        done(err);
      }
    };
    this.rebootTimer = setTimeout(() => {
      this.rebootTimer = null;
      attempt(0);
    }, this.rebootDelay);
  }

  // ── TCP streams ────────────────────────────────────────────────────────────

  /**
   * Allowlist for tcp-open: the port must be a configured tunnel port and, when the
   * server names a tunnelId, it must be the tunnel this client registered for that port.
   */
  _checkOpenAllowed(localPort, tunnelId) {
    const port = validPort(localPort);
    if (port === null || !this.tunnelPorts.has(port)) {
      return { ok: false, reason: `port ${sanitizeText(localPort, 20)} is not a configured tunnel port` };
    }
    if (tunnelId !== undefined && tunnelId !== null && tunnelId !== '') {
      const own = this.stateByPort[port]?.tunnelId;
      if (!sameTunnelId(own, tunnelId)) {
        return { ok: false, reason: `tunnel ${sanitizeText(tunnelId, 64)} is not this client's tunnel for port ${port}` };
      }
    }
    return { ok: true, port };
  }

  _onTcpOpen(msg) {
    const ws = this.ws;
    this.streamsSeen = true;
    const connId = normalizeConnId(msg.connId);
    if (!connId) {
      this._warnThrottled('Ignored tcp-open with an invalid connection id');
      return;
    }
    if (this.conns.has(connId)) {
      this._warnThrottled('Ignored duplicate tcp-open for an existing connection');
      return;
    }
    const check = this.useBinary && !isUuid(connId)
      ? { ok: false, reason: 'connection id is not a UUID' }
      : this._checkOpenAllowed(msg.localPort, msg.tunnelId);
    if (!check.ok) {
      this._warnThrottled(`Rejected connection request from server: ${check.reason}`);
      this._sendJson(ws, { type: 'tcp-close', connId });
      return;
    }
    this._openLocal(ws, connId, check.port);
  }

  _openLocal(ws, connId, port) {
    const socket = net.createConnection({
      host: this.localHost,
      port,
      allowHalfOpen: true,
      writableHighWaterMark: LOCAL_WRITE_HIGH_WATER,
    });
    const conn = {
      id: connId,
      ws,
      socket,
      port,
      sentClose: false, // we told the peer "no more data" (at most once)
      receivedClose: false, // the peer told us "no more data"
      pausedByPeer: false, // peer sent tcp-pause
      readPaused: false, // socket.pause() currently in effect
      sentPause: false, // we sent tcp-pause and owe a tcp-resume
      stallTimer: null, // see _updateStallTimer
    };
    this.conns.set(connId, conn);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onLocalData(conn, chunk));
    socket.on('end', () => this._onLocalEnd(conn));
    socket.on('drain', () => this._onLocalDrain(conn));
    socket.on('error', (err) => this._onLocalError(conn, err));
    socket.on('close', () => this._onLocalClose(conn));
    this._updateReading(conn);
  }

  _onLocalData(conn, chunk) {
    const ws = conn.ws;
    if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) {
      conn.socket.destroy();
      return;
    }
    if (this.useBinary) {
      for (let off = 0; off < chunk.length; off += MAX_FRAME_PAYLOAD) {
        const part = chunk.subarray(off, Math.min(off + MAX_FRAME_PAYLOAD, chunk.length));
        ws.send(encodeDataFrame(conn.id, part), { binary: true }, this._onSendDone);
      }
    } else {
      for (let off = 0; off < chunk.length; off += MAX_LEGACY_CHUNK) {
        const part = chunk.subarray(off, Math.min(off + MAX_LEGACY_CHUNK, chunk.length));
        ws.send(JSON.stringify({ type: 'tcp-data', connId: conn.id, data: part.toString('base64') }), this._onSendDone);
      }
    }
    this._checkCongestion(ws);
  }

  _onLocalEnd(conn) {
    this._sendClose(conn);
    // v1 peers expect the old full-close behaviour (they may never answer with tcp-close).
    if (!this.useFlowControl && !conn.socket.writableEnded) conn.socket.end();
  }

  _onLocalDrain(conn) {
    if (!conn.sentPause) return;
    conn.sentPause = false;
    if (!conn.receivedClose && this.useFlowControl) {
      this._sendJson(conn.ws, { type: 'tcp-resume', connId: conn.id });
    }
  }

  _onLocalError(conn, err) {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH')) {
      this._warnThrottled(`Local service on port ${conn.port} is not reachable (${err.code}); is it running?`);
    }
    this._sendClose(conn);
    conn.socket.destroy();
  }

  _onLocalClose(conn) {
    this._sendClose(conn);
    if (conn.stallTimer) {
      clearTimeout(conn.stallTimer);
      conn.stallTimer = null;
    }
    if (this.conns.get(conn.id) === conn) this.conns.delete(conn.id);
  }

  _sendClose(conn) {
    if (conn.sentClose) return;
    conn.sentClose = true;
    this._sendJson(conn.ws, { type: 'tcp-close', connId: conn.id });
  }

  _abortConn(conn) {
    this._sendClose(conn);
    conn.socket.destroy();
  }

  _writeLocal(conn, payload) {
    const socket = conn.socket;
    if (conn.receivedClose || socket.destroyed || socket.writableEnded) return;
    const ok = socket.write(payload);
    if (!ok && this.useFlowControl && !conn.sentPause) {
      conn.sentPause = true;
      this._sendJson(conn.ws, { type: 'tcp-pause', connId: conn.id });
    }
    if (socket.writableLength > LOCAL_WRITE_HARD_LIMIT) {
      this._warnThrottled(`Closing connection to local port ${conn.port}: the local service is not reading and the server keeps sending`);
      this._abortConn(conn);
    }
  }

  _onBinaryFrame(data) {
    let buf = data;
    if (Array.isArray(data)) buf = Buffer.concat(data);
    else if (!Buffer.isBuffer(data)) buf = Buffer.from(data);
    const frame = decodeFrame(buf);
    if (!frame || frame.type !== FRAME_DATA) return; // short or unknown frame types are ignored
    const conn = this.conns.get(frame.connId);
    if (!conn || frame.payload.length === 0) return;
    this._writeLocal(conn, frame.payload);
  }

  _onLegacyTcpData(msg) {
    const conn = this.conns.get(normalizeConnId(msg.connId));
    if (!conn || typeof msg.data !== 'string') return;
    const payload = Buffer.from(msg.data, 'base64');
    if (payload.length > 0) this._writeLocal(conn, payload);
  }

  _onRemoteClose(rawConnId) {
    const conn = this.conns.get(normalizeConnId(rawConnId));
    if (!conn || conn.receivedClose) return; // unknown / duplicate closes are ignored
    conn.receivedClose = true;
    // tcp-close only ends the peer's sending direction: an earlier tcp-pause stays in
    // force (the peer may still be draining what we sent and will send tcp-resume).
    this._updateStallTimer(conn);
    conn.socket.end();
  }

  _onRemotePause(rawConnId, paused) {
    const conn = this.conns.get(normalizeConnId(rawConnId));
    if (!conn || conn.pausedByPeer === paused) return;
    conn.pausedByPeer = paused;
    this._updateReading(conn);
    this._updateStallTimer(conn);
  }

  /**
   * A connection the peer has closed (tcp-close) while keeping us paused can only make
   * progress through a tcp-resume. A peer that forgot the connection never sends one,
   * and the local service would stay blocked on a socket we no longer read: give up
   * after halfCloseStallMs.
   */
  _updateStallTimer(conn) {
    const stalled = conn.receivedClose && conn.pausedByPeer;
    if (stalled && !conn.stallTimer) {
      conn.stallTimer = setTimeout(() => {
        conn.stallTimer = null;
        if (!conn.receivedClose || !conn.pausedByPeer || conn.socket.destroyed) return;
        this._warnThrottled(`Closing stalled connection to local port ${conn.port}: the server closed it without resuming`);
        this._abortConn(conn);
      }, this.halfCloseStallMs);
      if (typeof conn.stallTimer.unref === 'function') conn.stallTimer.unref();
    } else if (!stalled && conn.stallTimer) {
      clearTimeout(conn.stallTimer);
      conn.stallTimer = null;
    }
  }

  _destroyAllConns() {
    for (const conn of this.conns.values()) {
      conn.sentClose = true; // the session is gone; nothing to tell the peer
      if (conn.stallTimer) {
        clearTimeout(conn.stallTimer);
        conn.stallTimer = null;
      }
      conn.socket.destroy();
    }
    this.conns.clear();
  }

  // ── Legacy HTTP requests (old servers only) ────────────────────────────────

  _legacyRequestPort(localPort) {
    const httpTunnels = this.tunnels.filter((t) => t.protocol === 'http');
    if (localPort === undefined || localPort === null) return httpTunnels[0]?.port ?? null;
    const port = validPort(localPort);
    return httpTunnels.some((t) => t.port === port) ? port : null;
  }

  _handleLegacyRequest(msg) {
    const ws = this.ws;
    const id = typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 128 ? msg.id : null;
    if (!id) return;
    const startTime = Date.now();
    const method = msg.method === undefined ? 'GET'
      : (typeof msg.method === 'string' && /^[A-Za-z]{1,20}$/.test(msg.method) ? msg.method.toUpperCase() : null);
    const rawPath = msg.path === undefined ? '/' : (typeof msg.path === 'string' ? msg.path : null);
    const shownPath = sanitizeText(rawPath ?? '?', 200);
    let responded = false;

    const respond = (statusCode, headers, body) => {
      if (responded) return;
      responded = true;
      this._sendJson(ws, {
        type: 'response', id, statusCode, headers, body: body.toString('base64'), bodyEncoding: 'base64',
      });
      this.display.logRequest(method || '?', shownPath, statusCode, http.STATUS_CODES[statusCode] || '', Date.now() - startTime);
      this.display.render();
    };
    const plain = (statusCode, text) => respond(statusCode, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from(`${text}\n`));

    const port = this._legacyRequestPort(msg.localPort);
    if (port === null) {
      const target = msg.localPort === undefined || msg.localPort === null
        ? 'no http tunnel is configured' : `port ${sanitizeText(msg.localPort, 20)} is not a configured http tunnel port`;
      this._warnThrottled(`Rejected HTTP request from server: ${target}`);
      plain(403, 'Forbidden: port not allowed by the TunnelVault client');
      return;
    }
    if (!method || rawPath === null || !rawPath.startsWith('/')) {
      plain(400, 'Bad Request');
      return;
    }

    let path;
    try {
      const url = new URL(rawPath, 'http://localhost');
      path = url.pathname + url.search;
    } catch {
      plain(400, 'Bad Request');
      return;
    }
    const body = typeof msg.body === 'string' && msg.body.length > 0 ? Buffer.from(msg.body, 'base64') : null;

    let proxyReq;
    try {
      proxyReq = http.request({
        host: this.localHost,
        port,
        path,
        method,
        headers: legacyRequestHeaders(msg.headers, body),
      });
    } catch (err) {
      plain(400, `Bad Request: ${sanitizeText(err.message, 100)}`);
      return;
    }

    proxyReq.setTimeout(LEGACY_REQUEST_TIMEOUT, () => proxyReq.destroy(new Error('local service timed out')));
    proxyReq.on('response', (proxyRes) => {
      let chunks = [];
      let size = 0;
      proxyRes.on('data', (chunk) => {
        if (responded) return;
        size += chunk.length;
        if (size > LEGACY_MAX_RESPONSE_BYTES) {
          chunks = [];
          plain(502, 'Bad Gateway: response too large for the legacy tunnel protocol (upgrade the TunnelVault server)');
          proxyReq.destroy();
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const headers = {};
        for (const [key, val] of Object.entries(proxyRes.headers)) headers[key] = val;
        respond(proxyRes.statusCode, headers, Buffer.concat(chunks));
      });
      proxyRes.on('error', (err) => plain(502, `Bad Gateway: ${sanitizeText(err.message, 100)}`));
    });
    proxyReq.on('error', (err) => plain(502, `Bad Gateway: ${sanitizeText(err.message, 100)}`));
    if (body) proxyReq.write(body);
    proxyReq.end();
  }

  // ── State ──────────────────────────────────────────────────────────────────

  _loadState() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.display.warn(`Ignoring unreadable state file ${this.stateFile} (${err.code || 'invalid JSON'})`);
      }
      return {};
    }
    // Files written by older clients may be world-readable (they hold owner secrets).
    this._tightenPermissions();
    if (!saved || typeof saved !== 'object') return {};
    // Migrate legacy single-tunnel state
    if (typeof saved.tunnelId === 'string' && !saved.byPort) {
      return {
        [this.tunnels[0].port]: {
          tunnelId: saved.tunnelId,
          ownerSecret: typeof saved.ownerSecret === 'string' ? saved.ownerSecret : undefined,
        },
      };
    }
    const out = {};
    const byPort = saved.byPort && typeof saved.byPort === 'object' ? saved.byPort : {};
    for (const [key, value] of Object.entries(byPort)) {
      const port = validPort(key);
      if (port === null || !value || typeof value !== 'object') continue;
      if (typeof value.tunnelId !== 'string' || !value.tunnelId || value.tunnelId.length > 128) continue;
      out[port] = {
        tunnelId: value.tunnelId,
        ownerSecret: typeof value.ownerSecret === 'string' ? value.ownerSecret : undefined,
        publicUrl: typeof value.publicUrl === 'string' ? value.publicUrl : undefined,
        allocatedPort: validPort(value.allocatedPort),
      };
    }
    return out;
  }

  /** state dir -> 0700 (only a dedicated dir we own; never a shared sticky dir), state.json -> 0600. */
  _tightenPermissions() {
    try {
      const st = statSync(this.stateDir);
      const ownedByUs = typeof process.getuid !== 'function' || st.uid === process.getuid();
      if (st.isDirectory() && ownedByUs && (st.mode & 0o077) !== 0 && (st.mode & 0o1000) === 0) {
        chmodSync(this.stateDir, 0o700);
      }
    } catch { /* best effort */ }
    try {
      const st = lstatSync(this.stateFile);
      if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(this.stateFile, 0o600);
    } catch { /* best effort */ }
  }

  _persistState() {
    const data = `${JSON.stringify({ byPort: this.stateByPort }, null, 2)}\n`;
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      this._tightenPermissions();
      // Atomic replace: a crash never leaves a truncated file (which would lose the owner
      // secrets and with them the device's stable public ports), and a planted symlink at
      // state.json is replaced rather than followed.
      const tmp = join(this.stateDir, `.state.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.stateFile);
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* not created */ }
        throw err;
      }
      chmodSync(this.stateFile, 0o600);
    } catch (err) {
      this._warnThrottled(`Could not save tunnel state to ${this.stateFile}: ${err.code || err.message}`);
    }
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  _buildTunnelLines() {
    return this.tunnels.map((t) => {
      const base = { name: t.name || `:${t.port}`, port: t.port };
      const error = this.tunnelErrors.get(t.port);
      if (error) return { ...base, status: `error: ${error}` };
      if (this.pausedTunnels.has(t.port)) return { ...base, status: 'paused (resume from dashboard)' };
      const s = this.stateByPort[t.port];
      if (!s || !this.liveTunnels.has(t.port)) return { ...base, status: s ? 'connecting…' : 'registering…' };
      const pub = s.allocatedPort ? `public port ${s.allocatedPort}` : (s.publicUrl || '—');
      return { ...base, public: pub };
    });
  }

  _updateDisplay() {
    this.display.setConnectedMulti(this._buildTunnelLines());
  }

  _warnThrottled(message) {
    const now = Date.now();
    if (now - this.warnWindowStart > WARN_WINDOW_MS) {
      if (this.warnSuppressed > 0) this.display.warn(`(${this.warnSuppressed} similar warnings suppressed)`);
      this.warnWindowStart = now;
      this.warnCount = 0;
      this.warnSuppressed = 0;
    }
    if (this.warnCount >= WARN_BURST) {
      this.warnSuppressed++;
      return;
    }
    this.warnCount++;
    this.display.warn(message);
  }
}
