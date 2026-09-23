'use strict';

/**
 * Minimal device implementation for tests (protocol v1 and v2), independent
 * of client/ code. Opens real TCP connections to local services on tcp-open
 * and implements v2 binary frames + flow control.
 */
const net = require('net');
const EventEmitter = require('events');
const WebSocket = require('ws');

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const MAX_FRAME = 256 * 1024;

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf, offset) {
  const h = buf.toString('hex', offset, offset + 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class FakeDevice extends EventEmitter {
  /**
   * @param {object} opts - url, token, protocol (1|2), host, headers, allowPorts (Set|null)
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.token = opts.token;
    this.protocol = opts.protocol || 2;
    this.host = opts.host || '127.0.0.1';
    this.extraHeaders = opts.headers || {};
    this.allowPorts = opts.allowPorts || null;
    this.messages = [];
    this._claimed = new Set();
    this._waiters = [];
    this.conns = new Map(); // connId -> conn
    this.v2 = false;        // becomes true after hello (and only if we asked for v2)
    this.congested = false;
    this.received = { tcpPause: 0, tcpResume: 0 };
    this.ws = null;
    this.closed = null;
  }

  connect() {
    const headers = { ...this.extraHeaders };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.protocol >= 2) headers['X-TunnelVault-Protocol'] = '2';
    const ws = new WebSocket(this.url, { headers, perMessageDeflate: false });
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
    ws.on('error', () => {});
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(this));
      ws.once('unexpected-response', (_req, res) => {
        const err = new Error(`Unexpected response ${res.statusCode}`);
        err.statusCode = res.statusCode;
        res.resume();
        reject(err);
      });
      ws.once('error', reject);
    });
  }

  /** Wait for (and claim) the first unclaimed message matching pred. */
  waitFor(pred, timeoutMs = 5000) {
    for (let i = 0; i < this.messages.length; i++) {
      if (!this._claimed.has(i) && pred(this.messages[i])) {
        this._claimed.add(i);
        return Promise.resolve(this.messages[i]);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w !== waiter);
        reject(new Error(`Timed out waiting for message; received: ${JSON.stringify(this.messages.map(m => m.type))}`));
      }, timeoutMs);
      waiter.resolve = (m) => { clearTimeout(timer); resolve(m); };
      this._waiters.push(waiter);
    });
  }

  send(obj) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj), () => this._afterSend());
    this._checkCongestion();
  }

  sendRaw(data, binary) {
    this.ws.send(data, { binary: !!binary });
  }

  register({ localPort, protocol = 'tcp', subdomain, name }) {
    this.send({ type: 'register', localPort, protocol, subdomain, name });
    return this.waitFor(m => (m.type === 'registered' || m.type === 'error') && m.localPort === localPort);
  }

  reconnect(tunnelId, ownerSecret) {
    this.send({ type: 'reconnect', tunnelId, ownerSecret });
    return this.waitFor(m => ['reconnected', 'standby', 'error'].includes(m.type) && m.tunnelId === tunnelId);
  }

  close(code = 1000) {
    for (const c of this.conns.values()) c.sock.destroy();
    this.conns.clear();
    if (this.ws && this.ws.readyState <= 1) this.ws.close(code);
    return this.closed;
  }

  terminate() {
    for (const c of this.conns.values()) c.sock.destroy();
    this.conns.clear();
    if (this.ws) this.ws.terminate();
    return this.closed;
  }

  // ── internals ──
  _onMessage(data, isBinary) {
    if (isBinary) {
      if (data.length < 17 || data[0] !== 0x01) return;
      const c = this.conns.get(bytesToUuid(data, 1));
      if (c) this._toLocal(c, data.subarray(17));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    this.messages.push(msg);
    const idx = this.messages.length - 1;
    for (const w of this._waiters) {
      if (w.pred(msg)) {
        this._claimed.add(idx);
        this._waiters = this._waiters.filter(x => x !== w);
        w.resolve(msg);
        break;
      }
    }
    this._handle(msg);
    this.emit('message', msg);
  }

  _handle(msg) {
    switch (msg.type) {
      case 'hello':
        this.v2 = this.protocol >= 2 && msg.protocolVersion >= 2;
        break;
      case 'tcp-open':
        this._open(msg);
        break;
      case 'tcp-data': {
        const c = this.conns.get(msg.connId);
        if (c) this._toLocal(c, Buffer.from(msg.data, 'base64'));
        break;
      }
      case 'tcp-close': {
        const c = this.conns.get(msg.connId);
        if (c) c.sock.end();
        break;
      }
      case 'tcp-pause': {
        this.received.tcpPause++;
        const c = this.conns.get(msg.connId);
        if (c) { c.remotePaused = true; c.sock.pause(); }
        break;
      }
      case 'tcp-resume': {
        this.received.tcpResume++;
        const c = this.conns.get(msg.connId);
        if (c) {
          c.remotePaused = false;
          if (!this.congested) c.sock.resume();
        }
        break;
      }
      default:
        break;
    }
  }

  _open({ connId, localPort }) {
    if (this.allowPorts && !this.allowPorts.has(localPort)) {
      this.send({ type: 'tcp-close', connId });
      return;
    }
    const sock = net.connect({ port: localPort, host: this.host });
    const c = { connId, idBytes: uuidToBytes(connId), sock, closeSent: false, remotePaused: false, pausedPeer: false };
    this.conns.set(connId, c);
    sock.on('data', (chunk) => {
      this._toServer(c, chunk);
      if (this.congested) sock.pause();
    });
    sock.on('drain', () => {
      if (c.pausedPeer) {
        c.pausedPeer = false;
        this.send({ type: 'tcp-resume', connId });
      }
    });
    const sendClose = () => {
      if (c.closeSent) return;
      c.closeSent = true;
      if (this.ws.readyState === 1) this.send({ type: 'tcp-close', connId });
    };
    sock.on('end', sendClose);
    sock.on('error', () => {});
    sock.on('close', () => {
      sendClose();
      this.conns.delete(connId);
    });
  }

  _toLocal(c, payload) {
    if (c.sock.destroyed) return;
    const ok = c.sock.write(payload);
    if (!ok && this.v2 && !c.pausedPeer) {
      c.pausedPeer = true;
      this.send({ type: 'tcp-pause', connId: c.connId });
    }
  }

  _toServer(c, chunk) {
    for (let off = 0; off < chunk.length; off += MAX_FRAME) {
      const part = chunk.subarray(off, Math.min(off + MAX_FRAME, chunk.length));
      if (this.v2) {
        const frame = Buffer.allocUnsafe(17 + part.length);
        frame[0] = 0x01;
        c.idBytes.copy(frame, 1);
        part.copy(frame, 17);
        this.ws.send(frame, { binary: true }, () => this._afterSend());
      } else {
        this.ws.send(JSON.stringify({ type: 'tcp-data', connId: c.connId, data: part.toString('base64') }), () => this._afterSend());
      }
    }
    this._checkCongestion();
  }

  _checkCongestion() {
    if (this.v2 && !this.congested && this.ws.bufferedAmount >= HIGH_WATER) this.congested = true;
  }

  _afterSend() {
    if (!this.congested) return;
    if (this.ws.readyState !== 1 || this.ws.bufferedAmount <= LOW_WATER) {
      this.congested = false;
      for (const c of this.conns.values()) {
        if (!c.remotePaused && !c.sock.destroyed) c.sock.resume();
      }
    }
  }
}

module.exports = { FakeDevice };
