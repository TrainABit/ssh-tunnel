'use strict';

/**
 * TunnelVault device wire protocol (server side).
 *
 * This module contains everything that is specific to the /ws device protocol:
 *   - constants (frame layout, limits, close codes, error codes)
 *   - binary DATA frame encoding/decoding (protocol v2)
 *   - strict validation of JSON control messages received from devices
 *   - TunnelChannel: one per device WebSocket, multiplexes tunnel streams
 *   - TunnelStream: a Duplex stream for one tunnelled TCP connection (connId),
 *     with backpressure in both directions (tcp-pause/tcp-resume + WebSocket
 *     high/low water marks).
 *
 * Both the public TCP listeners (tcpProxy.js) and the HTTP proxy
 * (proxyServer.js) use TunnelStream, so there is exactly one flow-control
 * implementation. See docs/PROTOCOL.md for the wire format.
 */

const { Duplex } = require('stream');
const { randomUUID } = require('crypto');
const { createLogger } = require('./logger');
const log = createLogger('protocol');

// ─── Constants ───────────────────────────────────────────
const PROTOCOL_VERSION = 2;
const PROTOCOL_HEADER = 'x-tunnelvault-protocol';
const FEATURES = Object.freeze(['binary-data', 'flow-control']);

const FRAME_DATA = 0x01;
const CONN_ID_BYTES = 16;
const FRAME_HEADER_BYTES = 1 + CONN_ID_BYTES; // 17

const WS_MAX_PAYLOAD = 1024 * 1024;        // server maxPayload (1 MiB)
const MAX_FRAME_PAYLOAD = 256 * 1024;      // senders never exceed 256 KiB of payload per frame
const WS_HIGH_WATER = 8 * 1024 * 1024;     // stop reading local sockets above this ws.bufferedAmount
const WS_LOW_WATER = 1024 * 1024;          // ...and resume below this
const STREAM_READ_HIGH_WATER = 1024 * 1024;   // device->public buffering before tcp-pause
const STREAM_WRITE_HIGH_WATER = 256 * 1024;   // public->device buffering before the source is paused
// Hard cap on data buffered for one connection that the peer keeps sending
// although we asked it to pause (or a legacy v1 peer that cannot be paused).
const STREAM_MAX_BUFFERED = 32 * 1024 * 1024;

const CLOSE_CODES = Object.freeze({
  TOKEN_REVOKED: 4000,
  PROTOCOL_VIOLATION: 4001,
  SUPERSEDED: 4003,
});

const ERROR_CODES = Object.freeze({
  TUNNEL_NOT_FOUND: 'TUNNEL_NOT_FOUND',
  TUNNEL_LIMIT: 'TUNNEL_LIMIT',
  INVALID_PORT: 'INVALID_PORT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
});

// Kept verbatim: protocol v1 clients match on this exact message text.
const TUNNEL_NOT_FOUND_MESSAGE = 'Tunnel not found for reconnect';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ─────────────────────────────────────────────

function isUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID_RE.test(value);
}

/** Canonical UUID string -> 16 raw bytes. */
function uuidToBytes(uuid) {
  if (!isUuid(uuid)) throw new TypeError('invalid connId');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** 16 raw bytes (at offset) -> canonical lower-case UUID string. */
function bytesToUuid(buf, offset = 0) {
  const h = buf.toString('hex', offset, offset + CONN_ID_BYTES);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Build one binary DATA frame: 0x01 | connId(16) | payload. */
function encodeDataFrame(connIdBytes, payload) {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  frame[0] = FRAME_DATA;
  connIdBytes.copy(frame, 1, 0, CONN_ID_BYTES);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Decode a binary frame. Returns { connId, payload } for DATA frames and null
 * for anything that must be ignored (unknown type, shorter than 17 bytes).
 */
function decodeDataFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEADER_BYTES) return null;
  if (buf[0] !== FRAME_DATA) return null;
  return { connId: bytesToUuid(buf, 1), payload: buf.subarray(FRAME_HEADER_BYTES) };
}

/** Parse the X-TunnelVault-Protocol request header (missing/invalid -> 1). */
function parseProtocolHeader(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string' || !/^\s*\d{1,4}\s*$/.test(value)) return 1;
  const n = parseInt(value, 10);
  return n >= 1 ? n : 1;
}

function helloMessage() {
  return { type: 'hello', protocolVersion: PROTOCOL_VERSION, features: [...FEATURES] };
}

// ─── Control message validation ──────────────────────────

function invalid(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function parsePort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }
  if (typeof value === 'string' && /^\d{1,5}$/.test(value)) {
    const n = parseInt(value, 10);
    return n >= 1 && n <= 65535 ? n : null;
  }
  return null;
}

function optionalString(value, max) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > max) return { ok: false };
  return { ok: true, value: value === '' ? undefined : value };
}

/**
 * Parse and validate a JSON text frame received from a device.
 * Never throws. Returns { ok: true, msg } with a normalised message or
 * { ok: false, error: { code, message, tunnelId? } }.
 */
function parseClientMessage(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid(ERROR_CODES.INVALID_MESSAGE, 'Invalid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid(ERROR_CODES.INVALID_MESSAGE, 'Message must be a JSON object');
  }
  const type = raw.type;
  if (typeof type !== 'string' || type.length === 0 || type.length > 32) {
    return invalid(ERROR_CODES.INVALID_MESSAGE, 'Missing or invalid message type');
  }

  switch (type) {
    case 'register': {
      const localPort = parsePort(raw.localPort);
      if (localPort === null) return invalid(ERROR_CODES.INVALID_PORT, 'localPort must be between 1 and 65535');
      const name = optionalString(raw.name, 256);
      if (!name.ok) return invalid(ERROR_CODES.INVALID_MESSAGE, 'name must be a string');
      const subdomain = optionalString(raw.subdomain, 255);
      if (!subdomain.ok) return invalid(ERROR_CODES.INVALID_MESSAGE, 'subdomain must be a string');
      let protocol = 'http';
      if (raw.protocol !== undefined && raw.protocol !== null && raw.protocol !== '') {
        if (raw.protocol !== 'tcp' && raw.protocol !== 'http') {
          return invalid(ERROR_CODES.INVALID_MESSAGE, "protocol must be 'tcp' or 'http'");
        }
        protocol = raw.protocol;
      }
      return { ok: true, msg: { type, localPort, name: name.value, subdomain: subdomain.value, protocol } };
    }

    case 'reconnect': {
      if (!isUuid(raw.tunnelId)) return invalid(ERROR_CODES.INVALID_MESSAGE, 'tunnelId must be a UUID');
      const tunnelId = raw.tunnelId.toLowerCase();
      if (typeof raw.ownerSecret !== 'string' || raw.ownerSecret.length === 0 || raw.ownerSecret.length > 256) {
        // Treated like a wrong secret so the device re-registers that tunnel.
        return invalid(ERROR_CODES.TUNNEL_NOT_FOUND, TUNNEL_NOT_FOUND_MESSAGE, { tunnelId });
      }
      return { ok: true, msg: { type, tunnelId, ownerSecret: raw.ownerSecret } };
    }

    case 'tcp-close':
    case 'tcp-pause':
    case 'tcp-resume': {
      if (!isUuid(raw.connId)) return invalid(ERROR_CODES.INVALID_MESSAGE, 'connId must be a UUID');
      return { ok: true, msg: { type, connId: raw.connId.toLowerCase() } };
    }

    case 'tcp-data': {
      if (!isUuid(raw.connId)) return invalid(ERROR_CODES.INVALID_MESSAGE, 'connId must be a UUID');
      if (typeof raw.data !== 'string') return invalid(ERROR_CODES.INVALID_MESSAGE, 'data must be a base64 string');
      return { ok: true, msg: { type, connId: raw.connId.toLowerCase(), data: raw.data } };
    }

    case 'response':
      // Legacy HTTP-over-JSON reply. Servers >= 2.0 never send `request`, so
      // these can only be stale; accepted and ignored.
      return { ok: true, msg: { type } };

    default:
      return invalid(ERROR_CODES.UNKNOWN_TYPE, 'Unknown message type');
  }
}

// ─── TunnelStream ────────────────────────────────────────

/**
 * Duplex stream for one tunnelled connection.
 *   writable side: bytes going to the device (public client -> device)
 *   readable side: bytes coming from the device (device -> public client)
 *
 * Backpressure:
 *   - writes are held (callback deferred) while the device asked us to pause
 *     (tcp-pause) or while the WebSocket is congested, so a piped source is
 *     paused by the normal stream machinery;
 *   - when the readable buffer is full (consumer slow) a v2 peer gets
 *     tcp-pause, and tcp-resume once the consumer reads again.
 *
 * Close semantics (see PROTOCOL.md): tcp-close is sent at most once, when the
 * writable side ends (_final) or when the stream is destroyed. A tcp-close
 * from the peer ends the readable side.
 *
 * The stream never emits 'error' (destroy() is always called without an
 * error) so callers only need to watch 'close'.
 */
class TunnelStream extends Duplex {
  constructor(channel, connId, opts = {}) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: opts.readableHighWaterMark || STREAM_READ_HIGH_WATER,
      writableHighWaterMark: opts.writableHighWaterMark || STREAM_WRITE_HIGH_WATER,
    });
    this.channel = channel;
    this.connId = connId;
    this.connIdBytes = uuidToBytes(connId);
    this.tunnelId = opts.tunnelId || null;
    this.localPort = opts.localPort || null;
    this.bytesFromPeer = 0;
    this.bytesToPeer = 0;
    // net.Socket look-alikes used by http.request({ createConnection })
    this.remoteAddress = undefined;
    this.connecting = false;

    this._onTraffic = typeof opts.onTraffic === 'function' ? opts.onTraffic : null;
    this._pending = null;          // { chunk, cb } held by backpressure
    this._remotePaused = false;    // peer sent tcp-pause
    this._pausedPeer = false;      // we sent tcp-pause
    this._closeSent = false;
    this._remoteEnded = false;
    this._timeoutMs = 0;
    this._timer = null;
    this._lastActivity = Date.now();
  }

  // ── Writable side ──
  _write(chunk, _encoding, cb) {
    this._pending = { chunk, cb };
    this._retryWrite();
  }

  _retryWrite() {
    const pending = this._pending;
    if (!pending || this.destroyed) return;
    if (this._remotePaused) return; // retried on tcp-resume
    if (this.channel.congested) {
      this.channel._waiting.add(this); // retried when the WebSocket drains
      return;
    }
    this._pending = null;
    if (!this.channel.isOpen) {
      // Device connection gone: the channel tears every stream down.
      this.destroy();
      return;
    }
    const n = pending.chunk.length;
    this.bytesToPeer += n;
    this._touch();
    this.channel._sendData(this, pending.chunk);
    if (this._onTraffic) this._safeTraffic(n, 0);
    pending.cb();
  }

  _final(cb) {
    this._sendClose();
    cb();
  }

  // ── Readable side ──
  _read() {
    if (this._pausedPeer) {
      this._pausedPeer = false;
      this.channel.sendControl({ type: 'tcp-resume', connId: this.connId });
    }
  }

  _destroy(err, cb) {
    this._pending = null;
    this.channel._waiting.delete(this);
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._sendClose();
    this.channel._forget(this);
    cb(err);
  }

  _sendClose() {
    if (this._closeSent) return;
    this._closeSent = true;
    this.channel.sendControl({ type: 'tcp-close', connId: this.connId });
  }

  _safeTraffic(inBytes, outBytes) {
    try { this._onTraffic(inBytes, outBytes); } catch (err) {
      log.warn('Traffic accounting callback failed', { error: err.message });
    }
  }

  // ── Events from the peer (called by TunnelChannel) ──
  _onRemoteData(payload) {
    if (this._remoteEnded || this.destroyed || payload.length === 0) return;
    const n = payload.length;
    this.bytesFromPeer += n;
    this._touch();
    if (this._onTraffic) this._safeTraffic(0, n);
    if (this.push(payload)) return;
    if (this.readableLength > this.channel.streamMaxBuffered) {
      log.warn('Tunnel peer ignored flow control; dropping connection', {
        connId: this.connId, tunnelId: this.tunnelId, buffered: this.readableLength,
      });
      if (this.channel.flowControl) this.channel._reportViolation('Flow control ignored');
      this.destroy();
      return;
    }
    if (this.channel.flowControl && !this._pausedPeer) {
      this._pausedPeer = true;
      this.channel.sendControl({ type: 'tcp-pause', connId: this.connId });
    }
  }

  _onRemoteClose() {
    if (this._remoteEnded) return;
    this._remoteEnded = true;
    this._touch();
    if (!this.destroyed) this.push(null);
  }

  _onRemotePause() {
    this._remotePaused = true;
  }

  _onRemoteResume() {
    if (!this._remotePaused) return;
    this._remotePaused = false;
    this._retryWrite();
  }

  // ── Idle timeout (net.Socket compatible: emits 'timeout') ──
  _touch() {
    this._lastActivity = Date.now();
  }

  setTimeout(ms, callback) {
    if (typeof callback === 'function') this.once('timeout', callback);
    this._timeoutMs = Number(ms) > 0 ? Number(ms) : 0;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._timeoutMs > 0 && !this.destroyed) {
      this._touch();
      this._armTimer(this._timeoutMs);
    }
    return this;
  }

  _armTimer(delay) {
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this.destroyed || this._timeoutMs === 0) return;
      const idle = Date.now() - this._lastActivity;
      if (idle >= this._timeoutMs) {
        this.emit('timeout');
        // like net.Socket: keep firing on further inactivity until reset
        if (!this.destroyed && this._timeoutMs > 0) this._armTimer(this._timeoutMs);
      } else {
        this._armTimer(this._timeoutMs - idle);
      }
    }, delay);
    this._timer.unref();
  }

  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

// ─── TunnelChannel ───────────────────────────────────────

/**
 * Per-WebSocket multiplexer. `binary` selects v2 binary DATA frames (else v1
 * JSON tcp-data with base64); `flowControl` enables sending tcp-pause/resume.
 * Incoming binary frames and tcp-pause/resume are honoured regardless.
 */
class TunnelChannel {
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.binary = !!opts.binary;
    this.flowControl = !!opts.flowControl;
    this.highWater = opts.highWater || WS_HIGH_WATER;
    this.lowWater = Math.min(opts.lowWater || WS_LOW_WATER, this.highWater);
    this.maxFramePayload = Math.min(opts.maxFramePayload || MAX_FRAME_PAYLOAD, MAX_FRAME_PAYLOAD);
    this.streamMaxBuffered = opts.streamMaxBuffered || STREAM_MAX_BUFFERED;
    this.streamOptions = {
      readableHighWaterMark: opts.readableHighWaterMark,
      writableHighWaterMark: opts.writableHighWaterMark,
    };
    this.streams = new Map(); // connId -> TunnelStream
    this.congested = false;
    this.closed = false;
    this.onViolation = typeof opts.onViolation === 'function' ? opts.onViolation : null;
    this._waiting = new Set();
    this._onSent = () => this._afterSend();
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === 1;
  }

  get size() {
    return this.streams.size;
  }

  /** Open a new tunnel stream: sends tcp-open and returns the stream (or null). */
  openStream({ tunnelId, localPort, onTraffic } = {}) {
    if (!this.isOpen) return null;
    const connId = randomUUID();
    const stream = new TunnelStream(this, connId, { tunnelId, localPort, onTraffic, ...this.streamOptions });
    this.streams.set(connId, stream);
    this.sendControl({ type: 'tcp-open', connId, tunnelId, localPort });
    return stream;
  }

  /** Send a JSON control message. Returns false if the socket is not open. */
  sendControl(msg) {
    if (!this.isOpen) return false;
    try {
      this.ws.send(JSON.stringify(msg), this._onSent);
    } catch (err) {
      log.warn('Failed to send control message', { type: msg.type, error: err.message });
      return false;
    }
    this._checkCongestion();
    return true;
  }

  _sendData(stream, chunk) {
    const max = this.maxFramePayload;
    try {
      for (let off = 0; off < chunk.length; off += max) {
        const part = chunk.length <= max ? chunk : chunk.subarray(off, Math.min(off + max, chunk.length));
        if (this.binary) {
          this.ws.send(encodeDataFrame(stream.connIdBytes, part), { binary: true }, this._onSent);
        } else {
          this.ws.send(JSON.stringify({ type: 'tcp-data', connId: stream.connId, data: part.toString('base64') }), this._onSent);
        }
      }
    } catch (err) {
      log.warn('Failed to send tunnel data', { connId: stream.connId, error: err.message });
    }
    this._checkCongestion();
  }

  _checkCongestion() {
    if (!this.congested && this.ws.bufferedAmount >= this.highWater) this.congested = true;
  }

  _afterSend() {
    if (!this.congested) return;
    if (this.ws.readyState !== 1 || this.ws.bufferedAmount <= this.lowWater) {
      this.congested = false;
      this._flushWaiting();
    }
  }

  _flushWaiting() {
    for (const stream of [...this._waiting]) {
      if (this.congested) break;
      this._waiting.delete(stream);
      stream._retryWrite();
    }
  }

  _reportViolation(reason) {
    if (!this.onViolation) return;
    try { this.onViolation(reason); } catch (err) {
      log.warn('onViolation callback failed', { error: err.message });
    }
  }

  _forget(stream) {
    if (this.streams.get(stream.connId) === stream) this.streams.delete(stream.connId);
    this._waiting.delete(stream);
  }

  /** Handle a binary WebSocket frame. Malformed/unknown frames are ignored. */
  handleBinary(buf) {
    const frame = decodeDataFrame(buf);
    if (!frame) return;
    const stream = this.streams.get(frame.connId);
    if (stream) stream._onRemoteData(frame.payload);
  }

  /** Handle a validated stream control message (tcp-data/close/pause/resume). */
  handleControl(msg) {
    const stream = this.streams.get(msg.connId);
    if (!stream) return; // unknown / already forgotten connIds are ignored
    switch (msg.type) {
      case 'tcp-data':
        stream._onRemoteData(Buffer.from(msg.data, 'base64'));
        break;
      case 'tcp-close':
        stream._onRemoteClose();
        break;
      case 'tcp-pause':
        stream._onRemotePause();
        break;
      case 'tcp-resume':
        stream._onRemoteResume();
        break;
      default:
        break;
    }
  }

  /** Tear down every stream (the WebSocket is gone). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this._waiting.clear();
    for (const stream of [...this.streams.values()]) stream.destroy();
    this.streams.clear();
  }
}

/**
 * Open a tunnel stream to the device currently serving `tunnel`.
 * Returns null when the tunnel has no open device connection.
 */
function openTunnelStream(tunnel, opts = {}) {
  if (!tunnel || !tunnel.clientWs) return null;
  const channel = tunnel.clientWs.tunnelChannel;
  if (!channel || !channel.isOpen) return null;
  return channel.openStream({ tunnelId: tunnel.id, localPort: tunnel.localPort, onTraffic: opts.onTraffic });
}

/**
 * Splice a local socket and a tunnel stream together with backpressure in both
 * directions. A clean end on either side is propagated as a half-close; an
 * abnormal close of either side destroys the other.
 */
function spliceSocket(socket, stream) {
  socket.on('error', () => {}); // ECONNRESET etc. -> 'close' below does the cleanup
  socket.pipe(stream);
  stream.pipe(socket);
  socket.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.once('close', () => {
    if (socket.destroyed) return;
    if (!stream.readableEnded) {
      // The tunnel went away mid-stream: reset the public connection.
      socket.destroy();
    } else if (!stream.writableFinished) {
      // The peer finished sending (pipe already called socket.end()), but we
      // can no longer forward what the socket sends: flush, then close.
      if (typeof socket.destroySoon === 'function') socket.destroySoon();
      else socket.end();
    }
    // else: clean close in both directions, the socket closes by itself.
  });
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  FEATURES,
  FRAME_DATA,
  CONN_ID_BYTES,
  FRAME_HEADER_BYTES,
  WS_MAX_PAYLOAD,
  MAX_FRAME_PAYLOAD,
  WS_HIGH_WATER,
  WS_LOW_WATER,
  STREAM_READ_HIGH_WATER,
  STREAM_WRITE_HIGH_WATER,
  STREAM_MAX_BUFFERED,
  CLOSE_CODES,
  ERROR_CODES,
  TUNNEL_NOT_FOUND_MESSAGE,
  isUuid,
  uuidToBytes,
  bytesToUuid,
  encodeDataFrame,
  decodeDataFrame,
  parseProtocolHeader,
  helloMessage,
  parseClientMessage,
  TunnelStream,
  TunnelChannel,
  openTunnelStream,
  spliceSocket,
};
