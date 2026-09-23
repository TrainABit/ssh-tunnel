// Integration tests for the device client against an in-test fake server (ws.WebSocketServer).
// Deliberately does not import any backend code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, mkdirSync, chmodSync, readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { TunnelClient } from '../src/tunnel.js';
import { QuietDisplay } from '../src/display.js';
import { FRAME_DATA, MAX_FRAME_PAYLOAD, decodeFrame, encodeDataFrame } from '../src/protocol.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'tv-client-test-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
let dirCounter = 0;
const freshStateDir = () => join(tmpRoot, `state-${++dirCounter}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 5000, interval = 5, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

// ── Fake TunnelVault server ──────────────────────────────────────────────────

class FakeConn {
  constructor(ws, req, server) {
    this.ws = ws;
    this.req = req;
    this.server = server;
    this.json = [];
    this.binaryFrames = 0;
    this.maxFrameLength = 0;
    this.data = new Map(); // connId -> Buffer[] (binary or legacy tcp-data)
    this.tunnels = new Map(); // localPort -> tunnelId
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.binaryFrames++;
        this.maxFrameLength = Math.max(this.maxFrameLength, data.length);
        const frame = decodeFrame(data);
        if (frame && frame.type === FRAME_DATA) this._addData(frame.connId, Buffer.from(frame.payload));
        return;
      }
      const msg = JSON.parse(data.toString());
      this.json.push(msg);
      if (msg.type === 'tcp-data') this._addData(msg.connId, Buffer.from(msg.data, 'base64'));
      if (msg.type === 'register' && server.autoRegister) this.acceptRegister(msg);
      if (msg.type === 'reconnect' && server.onReconnect) server.onReconnect(msg, this);
    });
  }

  _addData(connId, buf) {
    if (!this.data.has(connId)) this.data.set(connId, []);
    this.data.get(connId).push(buf);
  }

  received(connId) {
    return Buffer.concat(this.data.get(connId) || []);
  }

  receivedLength(connId) {
    return (this.data.get(connId) || []).reduce((n, b) => n + b.length, 0);
  }

  acceptRegister(msg) {
    const tunnelId = randomUUID();
    this.tunnels.set(msg.localPort, tunnelId);
    this.sendJson({
      type: 'registered',
      tunnelId,
      publicUrl: msg.protocol === 'http' ? `http://sub-${msg.localPort}.example.test` : 'tcp://example.test',
      ownerSecret: randomBytes(16).toString('hex'),
      protocol: msg.protocol,
      allocatedPort: msg.protocol === 'tcp' ? 10000 + (msg.localPort % 1000) : null,
      localPort: msg.localPort,
    });
  }

  sendJson(obj) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  /** v2: binary DATA frames; v1: JSON tcp-data. Resolves once handed to the socket. */
  async sendData(connId, buf, { legacy = false, shouldStop = () => false } = {}) {
    const step = legacy ? 64 * 1024 : MAX_FRAME_PAYLOAD;
    for (let off = 0; off < buf.length; off += step) {
      if (shouldStop()) return off;
      const part = buf.subarray(off, Math.min(off + step, buf.length));
      const payload = legacy
        ? JSON.stringify({ type: 'tcp-data', connId, data: part.toString('base64') })
        : encodeDataFrame(connId, part);
      await new Promise((resolve, reject) => this.ws.send(payload, { binary: !legacy }, (err) => (err ? reject(err) : resolve())));
    }
    return buf.length;
  }

  jsonOf(type, pred = () => true) {
    return this.json.filter((m) => m.type === type && pred(m));
  }

  waitJson(type, pred = () => true, timeout = 5000) {
    return waitFor(() => this.jsonOf(type, pred)[0], { timeout, what: `'${type}' message` });
  }
}

class FakeServer {
  static async start({ hello = true, autoRegister = true, onReconnect = null, verifyClient = undefined } = {}) {
    const s = new FakeServer();
    s.hello = hello;
    s.autoRegister = autoRegister;
    s.onReconnect = onReconnect;
    s.connections = [];
    s.upgradeAttempts = 0;
    s.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info, cb) => {
        s.upgradeAttempts++;
        if (verifyClient) verifyClient(info, cb);
        else cb(true);
      },
    });
    await new Promise((resolve) => s.wss.once('listening', resolve));
    s.url = `ws://127.0.0.1:${s.wss.address().port}`;
    s.wss.on('connection', (ws, req) => {
      if (s.hello) {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, features: ['binary-data', 'flow-control'] }));
      }
      s.connections.push(new FakeConn(ws, req, s));
    });
    return s;
  }

  nextConnection(index = 0) {
    return waitFor(() => this.connections[index], { what: `server connection #${index}` });
  }

  async close() {
    for (const c of this.connections) c.ws.terminate();
    await new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

// ── Local services the client forwards to ────────────────────────────────────

async function localServer(onSocket = () => {}, { allowHalfOpen = false } = {}) {
  const sockets = new Set();
  const info = { connections: 0, sockets };
  const srv = net.createServer({ allowHalfOpen }, (socket) => {
    info.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onSocket(socket, info);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  info.port = srv.address().port;
  info.close = () => {
    for (const s of sockets) s.destroy();
    return new Promise((resolve) => srv.close(() => resolve()));
  };
  return info;
}

const echoServer = () => localServer((socket) => socket.pipe(socket), { allowHalfOpen: true });

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function makeClient(server, options = {}) {
  const logs = [];
  const execCalls = [];
  const client = new TunnelClient({
    server: server.url,
    authToken: 'test-token-123',
    stateDir: freshStateDir(),
    localHost: '127.0.0.1',
    display: new QuietDisplay({ onLog: (level, message) => logs.push({ level, message }) }),
    exec: (file, args, cb) => { execCalls.push([file, args]); cb(null); },
    reconnectDelayMs: 20,
    maxReconnectDelayMs: 100,
    rebootDelayMs: 5,
    ...options,
  });
  client.logs = logs;
  client.execCalls = execCalls;
  client.logText = () => logs.map((l) => `${l.level}: ${l.message}`).join('\n');
  return client;
}

/** Connect and wait until every configured tunnel is registered. Returns the server connection. */
async function connectAndRegister(client, server, index = 0) {
  client.connect();
  const conn = await server.nextConnection(index);
  await waitFor(() => client.tunnels.every((t) => client.liveTunnels.has(t.port)), { what: 'tunnels registered' });
  return conn;
}

const cleanups = [];
function onCleanup(fn) { cleanups.push(fn); }
async function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { await fn(); } catch { /* ignore */ }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('v2: protocol header + Bearer auth; binary DATA frames after hello; echo round trip with tcp-close', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start({ hello: true });
  onCleanup(() => server.close());
  const echo = await echoServer();
  onCleanup(() => echo.close());
  const client = makeClient(server, { tunnels: [{ port: echo.port, protocol: 'tcp', name: 'ssh' }] });
  onCleanup(() => client.disconnect());

  const conn = await connectAndRegister(client, server);
  assert.equal(conn.req.headers['x-tunnelvault-protocol'], '2');
  assert.equal(conn.req.headers.authorization, 'Bearer test-token-123');
  assert.equal(new URL(conn.req.url, 'http://x').pathname, '/ws');
  assert.equal(new URL(conn.req.url, 'http://x').search, '', 'token must never be in the query string');
  assert.equal(client.useBinary, true);
  assert.equal(client.useFlowControl, true);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(echo.port), localPort: echo.port });
  const payload = randomBytes(3 * 1024 * 1024 + 123);
  await conn.sendData(connId, payload);
  await waitFor(() => conn.receivedLength(connId) >= payload.length, { what: 'echoed data', timeout: 10000 });
  assert.equal(sha256(conn.received(connId)), sha256(payload));
  assert.equal(conn.jsonOf('tcp-data').length, 0, 'no legacy base64 frames in v2');
  assert.ok(conn.binaryFrames > 0);
  assert.ok(conn.maxFrameLength <= 17 + MAX_FRAME_PAYLOAD);

  // Server says "no more data": the client ends the local socket, the echo service ends
  // its side, and the client reports tcp-close exactly once, then forgets the connId.
  conn.sendJson({ type: 'tcp-close', connId });
  await conn.waitJson('tcp-close', (m) => m.connId === connId);
  await waitFor(() => client.conns.size === 0, { what: 'connection forgotten' });
  await sleep(50);
  assert.equal(conn.jsonOf('tcp-close', (m) => m.connId === connId).length, 1);
  assert.ok(client._buildTunnelLines()[0].public.startsWith('public port '), 'display says "public port N"');
  // Duplicate / unknown closes are ignored
  conn.sendJson({ type: 'tcp-close', connId });
  conn.sendJson({ type: 'tcp-close', connId: randomUUID() });
  await sleep(30);
  assert.equal(conn.jsonOf('tcp-close', (m) => m.connId === connId).length, 1);
});

test('v1 fallback: without hello the client uses JSON base64 tcp-data and never sends tcp-pause/resume', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start({ hello: false });
  onCleanup(() => server.close());
  const echo = await echoServer();
  onCleanup(() => echo.close());
  let stalled = null;
  const sink = await localServer((socket) => { socket.pause(); stalled = socket; });
  onCleanup(() => sink.close());
  const client = makeClient(server, {
    tunnels: [{ port: echo.port, protocol: 'tcp' }, { port: sink.port, protocol: 'tcp' }],
  });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);
  assert.equal(client.useBinary, false);
  assert.equal(client.useFlowControl, false);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(echo.port), localPort: echo.port });
  const payload = randomBytes(512 * 1024 + 7);
  await conn.sendData(connId, payload, { legacy: true });
  await waitFor(() => conn.receivedLength(connId) >= payload.length, { what: 'echoed legacy data' });
  assert.equal(sha256(conn.received(connId)), sha256(payload));
  assert.equal(conn.binaryFrames, 0, 'no binary frames to a v1 server');
  assert.ok(conn.jsonOf('tcp-data', (m) => m.connId === connId).length > 0);

  // Local service that does not read: socket.write() returns false, but v1 has no flow control.
  const slowId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId: slowId, tunnelId: conn.tunnels.get(sink.port), localPort: sink.port });
  await waitFor(() => stalled, { what: 'sink connection' });
  await conn.sendData(slowId, randomBytes(12 * 1024 * 1024), { legacy: true });
  await waitFor(() => client.conns.get(slowId)?.socket.writableLength > 1024 * 1024, { what: 'local write buffer to fill' });
  await sleep(50);
  assert.equal(conn.jsonOf('tcp-pause').length, 0);
  assert.equal(conn.jsonOf('tcp-resume').length, 0);
  stalled.resume();
  await waitFor(() => client.conns.get(slowId)?.socket.writableLength === 0, { what: 'local buffer to drain' });
  await sleep(50);
  assert.equal(conn.jsonOf('tcp-pause').length + conn.jsonOf('tcp-resume').length, 0);
});

test('tcp-open for a port that is not configured is rejected without any local connection', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const echo = await echoServer();
  onCleanup(() => echo.close());
  const other = await localServer();
  onCleanup(() => other.close());
  const client = makeClient(server, { tunnels: [{ port: echo.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(echo.port), localPort: other.port });
  await conn.waitJson('tcp-close', (m) => m.connId === connId);
  for (const bad of [0, 70000, '22; rm -rf /', null]) {
    const id = randomUUID();
    conn.sendJson({ type: 'tcp-open', connId: id, tunnelId: conn.tunnels.get(echo.port), localPort: bad });
    await conn.waitJson('tcp-close', (m) => m.connId === id);
  }
  await sleep(100);
  assert.equal(other.connections, 0, 'no connection to the non-allowlisted port');
  assert.equal(echo.connections, 0);
  assert.equal(client.conns.size, 0);
  assert.match(client.logText(), /not a configured tunnel port/);
});

test('tcp-open with a foreign tunnelId is rejected; without tunnelId the port allowlist alone applies', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const echo = await echoServer();
  onCleanup(() => echo.close());
  const client = makeClient(server, { tunnels: [{ port: echo.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  for (const tunnelId of [randomUUID(), 12345, { id: 1 }]) {
    const connId = randomUUID();
    conn.sendJson({ type: 'tcp-open', connId, tunnelId, localPort: echo.port });
    await conn.waitJson('tcp-close', (m) => m.connId === connId);
  }
  await sleep(100);
  assert.equal(echo.connections, 0, 'foreign tunnelId must not reach the local service');
  assert.match(client.logText(), /is not this client's tunnel/);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, localPort: echo.port });
  await waitFor(() => echo.connections === 1, { what: 'allowed connection' });
  await conn.sendData(connId, Buffer.from('ping'));
  await waitFor(() => conn.received(connId).toString() === 'ping', { what: 'echo' });
});

test('local connection refused -> tcp-close is sent to the server', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const deadPort = await freePort();
  const client = makeClient(server, { tunnels: [{ port: deadPort, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(deadPort), localPort: deadPort });
  await conn.waitJson('tcp-close', (m) => m.connId === connId);
  await waitFor(() => client.conns.size === 0, { what: 'connection forgotten' });
  await sleep(30);
  assert.equal(conn.jsonOf('tcp-close', (m) => m.connId === connId).length, 1, 'tcp-close sent exactly once');
  assert.match(client.logText(), /not reachable \(ECONNREFUSED\)/);
});

test('local service closing first -> tcp-close; data still flows the other way (half-close)', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const chunks = [];
  let localSocket = null;
  const svc = await localServer((socket) => {
    localSocket = socket;
    socket.on('data', (d) => chunks.push(d));
    socket.end('bye'); // service sends a greeting and half-closes
  }, { allowHalfOpen: true });
  onCleanup(() => svc.close());
  const client = makeClient(server, { tunnels: [{ port: svc.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(svc.port), localPort: svc.port });
  await conn.waitJson('tcp-close', (m) => m.connId === connId);
  assert.equal(conn.received(connId).toString(), 'bye');
  await conn.sendData(connId, Buffer.from('late data'));
  await waitFor(() => Buffer.concat(chunks).toString() === 'late data', { what: 'data after local half-close' });
  conn.sendJson({ type: 'tcp-close', connId });
  await waitFor(() => client.conns.size === 0 && localSocket.destroyed, { what: 'full close' });
});

test('tcp-pause / tcp-resume from the server stop and restart reading the local socket', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  let produced = 0;
  let stop = false;
  const source = await localServer((socket) => {
    const chunk = randomBytes(64 * 1024);
    const pump = () => {
      while (!stop && !socket.destroyed) {
        produced += chunk.length;
        if (!socket.write(chunk)) return;
      }
    };
    socket.on('drain', pump);
    pump();
  });
  onCleanup(() => { stop = true; return source.close(); });
  const client = makeClient(server, { tunnels: [{ port: source.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(source.port), localPort: source.port });
  await waitFor(() => conn.receivedLength(connId) > 1024 * 1024, { what: 'initial data' });
  conn.sendJson({ type: 'tcp-pause', connId });
  await waitFor(() => client.conns.get(connId)?.readPaused, { what: 'local read paused' });
  await sleep(150); // let frames already in flight arrive
  const before = conn.receivedLength(connId);
  await sleep(300);
  assert.equal(conn.receivedLength(connId), before, 'no data forwarded while paused');

  conn.sendJson({ type: 'tcp-resume', connId });
  await waitFor(() => conn.receivedLength(connId) > before + 1024 * 1024, { what: 'data after resume' });
  assert.ok(produced > 0);
});

test('local socket backpressure -> tcp-pause, then tcp-resume on drain (v2)', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  let stalled = null;
  let consumed = 0;
  const sink = await localServer((socket) => {
    socket.pause();
    stalled = socket;
    socket.on('data', (d) => { consumed += d.length; });
  });
  onCleanup(() => sink.close());
  const client = makeClient(server, { tunnels: [{ port: sink.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(sink.port), localPort: sink.port });
  await waitFor(() => stalled, { what: 'sink connection' });
  const isPaused = () => conn.jsonOf('tcp-pause', (m) => m.connId === connId).length > 0;
  const sent = await conn.sendData(connId, randomBytes(64 * 1024 * 1024), { shouldStop: isPaused });
  await conn.waitJson('tcp-pause', (m) => m.connId === connId);
  assert.ok(sent < 64 * 1024 * 1024, 'fake server stopped sending after tcp-pause');
  assert.equal(conn.jsonOf('tcp-resume').length, 0);

  stalled.resume();
  await conn.waitJson('tcp-resume', (m) => m.connId === connId, 10000);
  await waitFor(() => consumed === sent, { what: 'all data delivered locally', timeout: 10000 });
});

test('WebSocket congestion (bufferedAmount) pauses reading local sockets until it drains', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  let produced = 0;
  let stop = false;
  const source = await localServer((socket) => {
    const chunk = randomBytes(64 * 1024);
    const pump = () => {
      while (!stop && !socket.destroyed) {
        produced += chunk.length;
        if (!socket.write(chunk)) return;
      }
    };
    socket.on('drain', pump);
    pump();
  });
  onCleanup(() => { stop = true; return source.close(); });
  const client = makeClient(server, {
    tunnels: [{ port: source.port, protocol: 'tcp' }],
    wsHighWaterMark: 512 * 1024,
    wsLowWaterMark: 64 * 1024,
  });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  conn.ws._socket.pause(); // the server stops reading its WebSocket
  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(source.port), localPort: source.port });
  await waitFor(() => client.wsCongested, { what: 'client to detect congestion', timeout: 15000 });
  assert.equal(client.conns.get(connId).readPaused, true);
  await sleep(200);
  const plateau = produced;
  await sleep(300);
  assert.equal(produced, plateau, 'local source is throttled while the WebSocket is congested');
  assert.ok(client.ws.bufferedAmount < 512 * 1024 + 2 * MAX_FRAME_PAYLOAD + 64 * 1024, 'client buffering stays bounded');

  conn.ws._socket.resume();
  await waitFor(() => !client.wsCongested, { what: 'congestion to clear', timeout: 15000 });
  await waitFor(() => produced > plateau + 1024 * 1024, { what: 'local reads to resume', timeout: 15000 });
});

test('remote reboot is ignored unless explicitly allowed', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const port = await freePort();

  const denied = makeClient(server, { tunnels: [{ port, protocol: 'tcp' }] });
  onCleanup(() => denied.disconnect());
  const conn1 = await connectAndRegister(denied, server, 0);
  conn1.sendJson({ type: 'reboot' });
  await waitFor(() => /Ignored remote reboot/.test(denied.logText()), { what: 'ignore log line' });
  await sleep(50);
  assert.deepEqual(denied.execCalls, []);

  const allowed = makeClient(server, { tunnels: [{ port, protocol: 'tcp' }], allowReboot: true });
  let failFirst = true;
  allowed.exec = (file, args, cb) => {
    allowed.execCalls.push([file, args]);
    if (failFirst) { failFirst = false; cb(new Error('no systemctl')); } else cb(null);
  };
  onCleanup(() => allowed.disconnect());
  const conn2 = await connectAndRegister(allowed, server, 1);
  conn2.sendJson({ type: 'reboot' });
  await waitFor(() => allowed.execCalls.length === 2, { what: 'reboot commands' });
  assert.deepEqual(allowed.execCalls, [['sudo', ['-n', 'systemctl', 'reboot']], ['sudo', ['-n', 'reboot']]]);
});

test('state.json is written 0600 inside a 0700 directory; old loose permissions are tightened', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const port = await freePort();
  const stateDir = join(freshStateDir(), 'nested');
  const client = makeClient(server, { tunnels: [{ port, protocol: 'tcp' }], stateDir });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  const file = join(stateDir, 'state.json');
  await waitFor(() => existsSync(file), { what: 'state file' });
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(saved.byPort[port].tunnelId, conn.tunnels.get(port));
  assert.equal(typeof saved.byPort[port].ownerSecret, 'string');
  assert.deepEqual(readdirSync(stateDir), ['state.json'], 'no temp files left behind');

  // Files from older clients (0644 in a 0755 dir) are tightened on load.
  const oldDir = freshStateDir();
  mkdirSync(oldDir);
  chmodSync(oldDir, 0o755);
  const oldFile = join(oldDir, 'state.json');
  writeFileSync(oldFile, JSON.stringify({ byPort: { [port]: { tunnelId: 'abc', ownerSecret: 's' } } }));
  chmodSync(oldFile, 0o644);
  const reloaded = makeClient(server, { tunnels: [{ port, protocol: 'tcp' }], stateDir: oldDir });
  assert.equal(statSync(oldDir).mode & 0o777, 0o700);
  assert.equal(statSync(oldFile).mode & 0o777, 0o600);
  assert.equal(reloaded.stateByPort[port].tunnelId, 'abc');

  // Legacy single-tunnel state file is migrated to the first tunnel's port.
  const legacyDir = freshStateDir();
  mkdirSync(legacyDir, { mode: 0o700 });
  writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({ tunnelId: 'legacy-id', ownerSecret: 'x' }));
  const migrated = makeClient(server, { tunnels: [{ port, protocol: 'tcp' }], stateDir: legacyDir });
  assert.equal(migrated.stateByPort[port].tunnelId, 'legacy-id');
});

function seedState(stateDir, entries) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const byPort = {};
  for (const [port, tunnelId] of entries) byPort[port] = { tunnelId, ownerSecret: `secret-${tunnelId}` };
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ byPort }), { mode: 0o600 });
}

test('TUNNEL_NOT_FOUND (with tunnelId) re-registers only that tunnel', async (t) => {
  t.after(runCleanups);
  const [portA, portB] = [await freePort(), await freePort()];
  const [idA, idB] = [randomUUID(), randomUUID()];
  const server = await FakeServer.start({
    onReconnect: (msg, conn) => {
      assert.equal(msg.ownerSecret, `secret-${msg.tunnelId}`);
      if (msg.tunnelId === idA) {
        conn.tunnels.set(portA, idA);
        conn.sendJson({ type: 'reconnected', tunnelId: idA, publicUrl: 'tcp://x', allocatedPort: 10555, localPort: portA, protocol: 'tcp' });
      } else {
        conn.sendJson({ type: 'error', code: 'TUNNEL_NOT_FOUND', tunnelId: msg.tunnelId, message: 'Tunnel not found for reconnect' });
      }
    },
  });
  onCleanup(() => server.close());
  const stateDir = freshStateDir();
  seedState(stateDir, [[portA, idA], [portB, idB]]);
  const client = makeClient(server, {
    tunnels: [{ port: portA, protocol: 'tcp' }, { port: portB, protocol: 'tcp' }],
    stateDir,
  });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);
  await sleep(100);

  assert.equal(conn.jsonOf('reconnect').length, 2);
  const registers = conn.jsonOf('register');
  assert.equal(registers.length, 1, 'only the missing tunnel is registered again');
  assert.equal(registers[0].localPort, portB);
  assert.equal(client.stateByPort[portA].tunnelId, idA, 'the healthy tunnel keeps its id (and stable port)');
  assert.equal(client.stateByPort[portA].allocatedPort, 10555);
  assert.equal(client.stateByPort[portB].tunnelId, conn.tunnels.get(portB));
  const saved = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal(saved.byPort[portA].tunnelId, idA);
  assert.equal(saved.byPort[portB].tunnelId, conn.tunnels.get(portB));
});

test('old server TUNNEL_NOT_FOUND without tunnelId: only failed reconnects are re-registered', async (t) => {
  t.after(runCleanups);
  const [portA, portB, portC] = [await freePort(), await freePort(), await freePort()];
  const [idA, idB, idC] = [randomUUID(), randomUUID(), randomUUID()];
  const server = await FakeServer.start({
    onReconnect: (msg, conn) => {
      if (msg.tunnelId === idA) {
        // success reply arrives late (old servers await the TCP listener first)
        setTimeout(() => {
          conn.tunnels.set(portA, idA);
          conn.sendJson({ type: 'reconnected', tunnelId: idA, publicUrl: 'tcp://x', allocatedPort: 10001, localPort: portA });
        }, 60);
      } else {
        conn.sendJson({ type: 'error', message: 'Tunnel not found for reconnect' });
      }
    },
  });
  onCleanup(() => server.close());
  const stateDir = freshStateDir();
  seedState(stateDir, [[portA, idA], [portB, idB], [portC, idC]]);
  const client = makeClient(server, {
    tunnels: [portA, portB, portC].map((port) => ({ port, protocol: 'tcp' })),
    stateDir,
  });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);
  await sleep(150);

  const registered = conn.jsonOf('register').map((m) => m.localPort).sort();
  assert.deepEqual(registered, [portB, portC].sort(), 'exactly the two failed tunnels, once each');
  assert.equal(client.stateByPort[portA].tunnelId, idA);
});

test('legacy HTTP request messages: only configured http tunnel ports are proxied', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start({ hello: false });
  onCleanup(() => server.close());
  const seen = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      res.setHeader('x-test', 'yes');
      res.end(`hello ${req.method} ${req.url}`);
    });
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  onCleanup(() => { web.closeAllConnections(); return new Promise((resolve) => web.close(resolve)); });
  const httpPort = web.address().port;
  const tcpSvc = await localServer();
  onCleanup(() => tcpSvc.close());

  const client = makeClient(server, {
    tunnels: [{ port: tcpSvc.port, protocol: 'tcp' }, { port: httpPort, protocol: 'http' }],
  });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);
  const response = (id) => conn.waitJson('response', (m) => m.id === id);
  const bodyOf = (m) => Buffer.from(m.body, 'base64').toString();

  // Old servers send no localPort: the first http tunnel is used (never a tcp tunnel).
  conn.sendJson({ type: 'request', id: 'r1', method: 'POST', path: '/hi?x=1', headers: { 'x-foo': 'bar', connection: 'upgrade', upgrade: 'websocket' }, body: Buffer.from('payload').toString('base64') });
  const r1 = await response('r1');
  assert.equal(r1.statusCode, 200);
  assert.equal(bodyOf(r1), 'hello POST /hi?x=1');
  assert.equal(r1.headers['x-test'], 'yes');
  assert.equal(seen[0].body, 'payload');
  assert.equal(seen[0].headers['x-foo'], 'bar');
  assert.equal(seen[0].headers.upgrade, undefined, 'hop-by-hop headers are not forwarded');

  conn.sendJson({ type: 'request', id: 'r2', method: 'GET', path: '/', headers: {}, localPort: tcpSvc.port });
  assert.equal((await response('r2')).statusCode, 403, 'tcp tunnel port is not an http target');
  conn.sendJson({ type: 'request', id: 'r3', method: 'GET', path: '/', headers: {}, localPort: 1 });
  assert.equal((await response('r3')).statusCode, 403, 'unconfigured port');
  conn.sendJson({ type: 'request', id: 'r4', method: 'GET', path: '/ok', headers: {}, localPort: httpPort });
  assert.equal((await response('r4')).statusCode, 200);
  conn.sendJson({ type: 'request', id: 'r5', method: 'GE T', path: '/', headers: {} });
  assert.equal((await response('r5')).statusCode, 400);
  conn.sendJson({ type: 'request', id: 'r6', method: 'GET', path: 'http://evil.example/', headers: {} });
  assert.equal((await response('r6')).statusCode, 400);
  conn.sendJson({ type: 'request', id: 'r7', method: 'GET', path: '/a b\r\nX-Injected: 1', headers: { 'x-bad': 'a\r\nb' } });
  assert.ok([400, 200].includes((await response('r7')).statusCode));
  await sleep(50);
  assert.equal(tcpSvc.connections, 0);
  assert.ok(seen.every((s) => s.headers['x-injected'] === undefined));
  assert.match(client.logText(), /Rejected HTTP request/);

  // A client without any http tunnel refuses legacy requests entirely.
  const tcpOnly = makeClient(server, { tunnels: [{ port: tcpSvc.port, protocol: 'tcp' }] });
  onCleanup(() => tcpOnly.disconnect());
  const conn2 = await connectAndRegister(tcpOnly, server, 1);
  conn2.sendJson({ type: 'request', id: 'q1', method: 'GET', path: '/', headers: {} });
  assert.equal((await conn2.waitJson('response', (m) => m.id === 'q1')).statusCode, 403);
  assert.equal(tcpSvc.connections, 0);
});

test('HTTP 401 on upgrade: logs "token revoked or invalid" and keeps retrying at max backoff', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start({ verifyClient: (info, cb) => cb(false, 401, 'Unauthorized') });
  onCleanup(() => server.close());
  const client = makeClient(server, { tunnels: [{ port: await freePort(), protocol: 'tcp' }], maxReconnectDelayMs: 60 });
  onCleanup(() => client.disconnect());
  client.connect();
  await waitFor(() => server.upgradeAttempts >= 3, { what: 'repeated attempts' });
  assert.match(client.logText(), /token revoked or invalid/);
  assert.equal(client.reconnectDelay, 60, 'backoff pinned at the maximum');
  assert.doesNotMatch(client.logText(), /test-token-123/, 'token never logged');
});

test('close code 4000 after open: logs "token revoked or invalid" and reconnects', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const client = makeClient(server, { tunnels: [{ port: await freePort(), protocol: 'tcp' }], maxReconnectDelayMs: 50 });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);
  conn.ws.close(4000, 'Token revoked');
  await server.nextConnection(1);
  assert.match(client.logText(), /token revoked or invalid/);
});

test('malformed or hostile server input does not crash the client', async (t) => {
  t.after(runCleanups);
  const server = await FakeServer.start();
  onCleanup(() => server.close());
  const echo = await echoServer();
  onCleanup(() => echo.close());
  const client = makeClient(server, { tunnels: [{ port: echo.port, protocol: 'tcp' }] });
  onCleanup(() => client.disconnect());
  const conn = await connectAndRegister(client, server);

  for (const raw of ['null', '[]', '42', '"str"', '{"type":5}', '{not json', '{"type":"tcp-data","connId":null,"data":7}',
    '{"type":"tcp-pause","connId":"x"}', '{"type":"tcp-resume"}', '{"type":"tcp-open","connId":{"a":1},"localPort":1}',
    '{"type":"reconnected","tunnelId":null}', '{"type":"registered","localPort":99999,"tunnelId":"x"}',
    '{"type":"error","message":"\\u001b[2J evil"}', '{"type":"standby"}', '{"type":"unknown-type"}']) {
    conn.sendJson(raw);
  }
  conn.ws.send(Buffer.alloc(5), { binary: true }); // too short
  const unknownType = encodeDataFrame(randomUUID(), Buffer.from('x'));
  unknownType[0] = 0x42;
  conn.ws.send(unknownType, { binary: true });
  conn.ws.send(encodeDataFrame(randomUUID(), Buffer.from('nobody')), { binary: true }); // unknown connId
  await sleep(50);
  assert.ok(!/\u001b/.test(client.logText()), 'control characters from the server are stripped');

  const connId = randomUUID();
  conn.sendJson({ type: 'tcp-open', connId, tunnelId: conn.tunnels.get(echo.port), localPort: echo.port });
  // Non-UUID connIds cannot be used with binary frames in v2 -> rejected.
  conn.sendJson({ type: 'tcp-open', connId: 'legacy-1', tunnelId: conn.tunnels.get(echo.port), localPort: echo.port });
  await conn.waitJson('tcp-close', (m) => m.connId === 'legacy-1');
  await conn.sendData(connId, Buffer.from('still alive'));
  await waitFor(() => conn.received(connId).toString() === 'still alive', { what: 'echo after garbage' });
  assert.equal(client.ws.readyState, 1);
});

test('plaintext ws:// to a public host triggers a warning; configuration errors throw', async () => {
  const logs = [];
  const client = new TunnelClient({
    server: 'ws://203.0.113.10:9',
    tunnels: [{ port: 22, protocol: 'tcp' }],
    stateDir: freshStateDir(),
    display: new QuietDisplay({ onLog: (level, message) => logs.push(`${level}: ${message}`) }),
    reconnectDelayMs: 10_000,
  });
  client.connect();
  await client.disconnect();
  assert.ok(logs.some((l) => /unencrypted ws:\/\//.test(l)), logs.join('\n'));

  const quiet = new QuietDisplay();
  const base = { stateDir: freshStateDir(), display: quiet };
  assert.throws(() => new TunnelClient({ ...base, server: 'ftp://x', tunnels: [{ port: 22 }] }), /ws:\/\/ or wss:\/\//);
  assert.throws(() => new TunnelClient({ ...base, tunnels: [{ port: 0 }] }), /Invalid tunnel port/);
  assert.throws(() => new TunnelClient({ ...base, tunnels: [{ port: 22, protocol: 'udp' }] }), /Invalid protocol/);
  assert.throws(() => new TunnelClient({ ...base, tunnels: [{ port: 22 }], authToken: 'has space' }), /Invalid auth token/);
  const dup = new TunnelClient({ ...base, tunnels: [{ port: 22 }, { port: 22, protocol: 'http' }] });
  assert.equal(dup.tunnels.length, 1);
});
