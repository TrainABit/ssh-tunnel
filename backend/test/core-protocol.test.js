'use strict';

// Unit tests for backend/src/protocol.js: frame codec, message validation,
// TunnelStream/TunnelChannel flow control, close semantics and memory caps.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'fatal';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const {
  encodeDataFrame, decodeDataFrame, uuidToBytes, bytesToUuid, parseProtocolHeader, parseClientMessage,
  helloMessage, TunnelChannel, spliceSocket, MAX_FRAME_PAYLOAD, FRAME_HEADER_BYTES,
} = require('../src/protocol');

/** Minimal stand-in for a ws WebSocket: records sends, lets tests control bufferedAmount. */
function fakeWs() {
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    callbacks: [],
    send(data, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      ws.sent.push({ data, binary: !!(opts && opts.binary) });
      if (cb) ws.callbacks.push(cb);
    },
    control() {
      return ws.sent.filter(s => !s.binary).map(s => JSON.parse(s.data));
    },
    binaryFrames() {
      return ws.sent.filter(s => s.binary).map(s => decodeDataFrame(s.data));
    },
    /** Complete the oldest n pending sends (all by default), like socket writes finishing. */
    flushCallbacks(n = ws.callbacks.length) {
      const cbs = ws.callbacks.splice(0, n);
      for (const cb of cbs) cb();
    },
  };
  return ws;
}

const tick = () => new Promise(r => setImmediate(r));

test('DATA frame codec round-trips and rejects junk', () => {
  const id = crypto.randomUUID();
  assert.equal(bytesToUuid(uuidToBytes(id)), id);
  const payload = crypto.randomBytes(1000);
  const frame = encodeDataFrame(uuidToBytes(id), payload);
  assert.equal(frame[0], 0x01);
  assert.equal(frame.length, FRAME_HEADER_BYTES + payload.length);
  const decoded = decodeDataFrame(frame);
  assert.equal(decoded.connId, id);
  assert.ok(decoded.payload.equals(payload));
  assert.equal(decodeDataFrame(Buffer.alloc(16, 1)), null, 'shorter than 17 bytes');
  assert.equal(decodeDataFrame(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(20)])), null, 'unknown type');
  assert.equal(decodeDataFrame('not a buffer'), null);
  assert.equal(decodeDataFrame(Buffer.concat([Buffer.from([0x01]), uuidToBytes(id)])).payload.length, 0);
  assert.throws(() => uuidToBytes('nope'));
});

test('protocol header parsing and hello', () => {
  assert.equal(parseProtocolHeader(undefined), 1);
  assert.equal(parseProtocolHeader('2'), 2);
  assert.equal(parseProtocolHeader(' 3 '), 3);
  assert.equal(parseProtocolHeader(['2', '1']), 2);
  assert.equal(parseProtocolHeader('0'), 1);
  assert.equal(parseProtocolHeader('2abc'), 1);
  assert.equal(parseProtocolHeader('99999999'), 1);
  assert.deepEqual(helloMessage(), { type: 'hello', protocolVersion: 2, features: ['binary-data', 'flow-control'] });
});

test('parseClientMessage validates every field', () => {
  const ok = (m) => parseClientMessage(JSON.stringify(m));
  assert.deepEqual(ok({ type: 'register', localPort: 22, protocol: 'tcp', name: 'pi' }).msg,
    { type: 'register', localPort: 22, name: 'pi', subdomain: undefined, protocol: 'tcp' });
  assert.equal(ok({ type: 'register', localPort: '8080' }).msg.localPort, 8080);
  assert.equal(ok({ type: 'register', localPort: 80 }).msg.protocol, 'http', 'default protocol');
  assert.equal(ok({ type: 'register', localPort: 80, subdomain: '' }).msg.subdomain, undefined);
  for (const localPort of [0, 65536, -1, 1.5, '22x', '', null, [], {}, true, '0080000']) {
    assert.equal(ok({ type: 'register', localPort }).error.code, 'INVALID_PORT', JSON.stringify(localPort));
  }
  assert.equal(ok({ type: 'register', localPort: 1, protocol: 'udp' }).error.code, 'INVALID_MESSAGE');
  assert.equal(ok({ type: 'register', localPort: 1, name: 'x'.repeat(257) }).error.code, 'INVALID_MESSAGE');
  assert.equal(ok({ type: 'register', localPort: 1, subdomain: 42 }).error.code, 'INVALID_MESSAGE');

  const id = crypto.randomUUID();
  assert.deepEqual(ok({ type: 'reconnect', tunnelId: id.toUpperCase(), ownerSecret: 's' }).msg,
    { type: 'reconnect', tunnelId: id, ownerSecret: 's' });
  const noSecret = ok({ type: 'reconnect', tunnelId: id });
  assert.equal(noSecret.error.code, 'TUNNEL_NOT_FOUND');
  assert.equal(noSecret.error.tunnelId, id);
  assert.equal(noSecret.error.message, 'Tunnel not found for reconnect');
  assert.equal(ok({ type: 'reconnect', tunnelId: id, ownerSecret: 'x'.repeat(257) }).error.code, 'TUNNEL_NOT_FOUND');
  assert.equal(ok({ type: 'reconnect', tunnelId: 'x', ownerSecret: 's' }).error.code, 'INVALID_MESSAGE');

  for (const type of ['tcp-close', 'tcp-pause', 'tcp-resume']) {
    assert.deepEqual(ok({ type, connId: id }).msg, { type, connId: id });
    assert.equal(ok({ type, connId: `${id}x` }).error.code, 'INVALID_MESSAGE');
  }
  assert.equal(ok({ type: 'tcp-data', connId: id, data: 'aGk=' }).msg.data, 'aGk=');
  assert.equal(ok({ type: 'tcp-data', connId: id, data: [1] }).error.code, 'INVALID_MESSAGE');
  assert.equal(ok({ type: 'response', id: 'x' }).ok, true);
  assert.equal(ok({ type: 'x'.repeat(40) }).error.code, 'INVALID_MESSAGE');
  assert.equal(ok({ type: 'nope' }).error.code, 'UNKNOWN_TYPE');
  for (const raw of ['', '{', 'null', '"str"', '42', '[]', '{"type":null}', '{"__proto__":{"type":"register"}}']) {
    assert.equal(parseClientMessage(raw).ok, false, raw);
  }
});

test('v2 channel: tcp-open, binary frames split at 256 KiB, tcp-close sent once', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true, flowControl: true });
  const stream = ch.openStream({ tunnelId: 't1', localPort: 22 });
  const [open] = ws.control();
  assert.deepEqual(open, { type: 'tcp-open', connId: stream.connId, tunnelId: 't1', localPort: 22 });

  const big = crypto.randomBytes(MAX_FRAME_PAYLOAD * 2 + 10);
  stream.write(big);
  await tick();
  const frames = ws.binaryFrames();
  assert.equal(frames.length, 3);
  assert.ok(frames.every(f => f.connId === stream.connId && f.payload.length <= MAX_FRAME_PAYLOAD));
  assert.ok(Buffer.concat(frames.map(f => f.payload)).equals(big));

  stream.end();
  await tick();
  stream.destroy();
  await tick();
  assert.equal(ws.control().filter(m => m.type === 'tcp-close').length, 1, 'tcp-close at most once');
  assert.equal(ch.size, 0);
});

test('v1 channel sends base64 tcp-data and never tcp-pause', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: false, flowControl: false, readableHighWaterMark: 16 });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  stream.write(Buffer.from('hello'));
  await tick();
  const data = ws.control().find(m => m.type === 'tcp-data');
  assert.equal(Buffer.from(data.data, 'base64').toString(), 'hello');
  ch.handleControl({ type: 'tcp-data', connId: stream.connId, data: Buffer.alloc(64).toString('base64') });
  assert.equal(ws.control().filter(m => m.type === 'tcp-pause').length, 0);
  stream.destroy();
});

test('peer data: pushed in order, tcp-pause when the reader is slow, tcp-resume when it reads', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true, flowControl: true, readableHighWaterMark: 1024 });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  const id = uuidToBytes(stream.connId);
  ch.handleBinary(encodeDataFrame(id, Buffer.alloc(600, 1)));
  assert.equal(ws.control().filter(m => m.type === 'tcp-pause').length, 0);
  ch.handleBinary(encodeDataFrame(id, Buffer.alloc(600, 2)));
  assert.equal(ws.control().filter(m => m.type === 'tcp-pause').length, 1);
  ch.handleBinary(encodeDataFrame(id, Buffer.alloc(10, 3)));
  assert.equal(ws.control().filter(m => m.type === 'tcp-pause').length, 1, 'paused once');
  const got = [];
  stream.on('data', c => got.push(c));
  await tick();
  assert.equal(Buffer.concat(got).length, 1210);
  assert.equal(ws.control().filter(m => m.type === 'tcp-resume').length, 1);
  // Unknown connIds and data after the peer's tcp-close are ignored.
  ch.handleBinary(encodeDataFrame(uuidToBytes(crypto.randomUUID()), Buffer.from('x')));
  ch.handleControl({ type: 'tcp-close', connId: stream.connId });
  ch.handleBinary(encodeDataFrame(id, Buffer.from('late')));
  await tick();
  assert.equal(Buffer.concat(got).length, 1210);
  assert.equal(stream.readableEnded, true);
  stream.destroy();
});

test('tcp-pause from the peer holds writes; tcp-resume releases them', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true, flowControl: true, writableHighWaterMark: 1024 });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  ch.handleControl({ type: 'tcp-pause', connId: stream.connId });
  const ok = stream.write(Buffer.alloc(2048));
  assert.equal(ok, false, 'writer sees backpressure');
  await tick();
  assert.equal(ws.binaryFrames().length, 0);
  ch.handleControl({ type: 'tcp-resume', connId: stream.connId });
  await tick();
  assert.equal(ws.binaryFrames().length, 1);
  stream.destroy();
});

test('WebSocket congestion holds all streams until bufferedAmount drops below the low-water mark', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true, flowControl: true, highWater: 1000, lowWater: 100 });
  const a = ch.openStream({ tunnelId: 't', localPort: 1 });
  const b = ch.openStream({ tunnelId: 't', localPort: 1 });
  ws.bufferedAmount = 5000;
  a.write(Buffer.alloc(10));
  await tick();
  assert.equal(ch.congested, true);
  const before = ws.binaryFrames().length;
  b.write(Buffer.alloc(10));
  a.write(Buffer.alloc(10));
  await tick();
  assert.equal(ws.binaryFrames().length, before, 'held while congested');
  assert.ok(ws.callbacks.length >= 2);
  ws.bufferedAmount = 500;
  ws.flushCallbacks(1);
  assert.equal(ch.congested, true, 'still above the low-water mark');
  ws.bufferedAmount = 50;
  ws.flushCallbacks();
  await tick();
  assert.equal(ch.congested, false);
  assert.equal(ws.binaryFrames().length, before + 2);
  a.destroy();
  b.destroy();
});

test('a peer ignoring tcp-pause is cut off at the per-stream cap (and reported)', () => {
  const ws = fakeWs();
  const violations = [];
  const ch = new TunnelChannel(ws, {
    binary: true, flowControl: true, readableHighWaterMark: 1024, streamMaxBuffered: 64 * 1024,
    onViolation: r => violations.push(r),
  });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  const id = uuidToBytes(stream.connId);
  for (let i = 0; i < 100 && !stream.destroyed; i++) ch.handleBinary(encodeDataFrame(id, Buffer.alloc(4096)));
  assert.equal(stream.destroyed, true);
  assert.ok(stream.readableLength <= 64 * 1024 + 4096);
  assert.deepEqual(violations, ['Flow control ignored']);
  assert.ok(ws.control().some(m => m.type === 'tcp-close' && m.connId === stream.connId));
});

test('the channel-wide buffer budget bounds memory across many streams', () => {
  const ws = fakeWs();
  const MiB = 1024 * 1024;
  const ch = new TunnelChannel(ws, {
    binary: false, flowControl: false, readableHighWaterMark: 1024, streamMaxBuffered: 8 * MiB, channelMaxBuffered: 10 * MiB,
  });
  const streams = Array.from({ length: 6 }, () => ch.openStream({ tunnelId: 't', localPort: 1 }));
  const chunk = Buffer.alloc(256 * 1024);
  for (let round = 0; round < 16; round++) {
    for (const s of streams) if (!s.destroyed) ch.handleBinary(encodeDataFrame(uuidToBytes(s.connId), chunk));
  }
  const total = streams.reduce((n, s) => n + (s.destroyed ? 0 : s.readableLength), 0);
  assert.ok(total <= 10 * MiB + 6 * MiB, `buffered ${total}`);
  assert.ok(streams.some(s => s.destroyed), 'some streams were dropped');
  for (const s of streams) s.destroy();
});

test('stream cap per channel and closed channels refuse new streams', () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true, maxStreams: 2 });
  assert.ok(ch.openStream({ tunnelId: 't', localPort: 1 }));
  assert.ok(ch.openStream({ tunnelId: 't', localPort: 1 }));
  assert.equal(ch.openStream({ tunnelId: 't', localPort: 1 }), null);
  ch.close();
  assert.equal(ch.size, 0);
  assert.equal(ch.openStream({ tunnelId: 't', localPort: 1 }), null);
  ws.readyState = 3;
  assert.equal(new TunnelChannel(ws).openStream({}), null);
});

test('closing the channel tears down its streams; spliceSocket resets the public side', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  const socket = new PassThrough();
  let socketDestroyed = false;
  socket.on('close', () => { socketDestroyed = true; });
  spliceSocket(socket, stream);
  ch.close();
  await tick();
  assert.equal(stream.destroyed, true);
  assert.equal(socketDestroyed, true);
});

test('idle timeout emits timeout only after inactivity', async () => {
  const ws = fakeWs();
  const ch = new TunnelChannel(ws, { binary: true });
  const stream = ch.openStream({ tunnelId: 't', localPort: 1 });
  let fired = 0;
  stream.setTimeout(80, () => { fired++; });
  const keepAlive = setInterval(() => ch.handleBinary(encodeDataFrame(uuidToBytes(stream.connId), Buffer.from('k'))), 20);
  await new Promise(r => setTimeout(r, 200));
  clearInterval(keepAlive);
  assert.equal(fired, 0);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fired, 1);
  stream.destroy();
});
