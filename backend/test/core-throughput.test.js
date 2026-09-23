'use strict';

// Data plane: loopback throughput with integrity (64 MiB each direction) and
// bounded memory under backpressure (slow public reader, slow local service,
// congested device WebSocket).
const { startHarness, listen, closeServer, waitUntil } = require('./helpers/core-harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const { once } = require('events');
const { FakeDevice } = require('./helpers/core-device');
const { WS_HIGH_WATER, STREAM_READ_HIGH_WATER } = require('../src/protocol');

const MiB = 1024 * 1024;
const TOTAL = 64 * MiB;
const MIN_MBPS = 20;

let h;
let payload;
let payloadDigest;
let sinkServer;
let sinkPort;
let sourceServer;
let sourcePort;
const devices = [];

async function device(opts = {}) {
  const d = new FakeDevice({ url: h.wsUrl, token: h.authToken, ...opts });
  devices.push(d);
  await d.connect();
  return d;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Write buf in 1 MiB slices honouring socket backpressure. */
async function writeAll(sock, buf) {
  for (let off = 0; off < buf.length; off += MiB) {
    if (!sock.write(buf.subarray(off, Math.min(off + MiB, buf.length)))) await once(sock, 'drain');
  }
}

/** Keep writing until stopped; returns { get sent(), stop() }. */
function flood(sock) {
  const block = crypto.randomBytes(64 * 1024);
  let sent = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && !sock.destroyed) {
      sent += block.length;
      if (!sock.write(block)) {
        sock.once('drain', pump);
        return;
      }
    }
  };
  setImmediate(pump);
  return { get sent() { return sent; }, stop() { stopped = true; } };
}

function channelOf(tunnelId) {
  return h.tunnelManager.getTunnel(tunnelId).clientWs.tunnelChannel;
}

before(async () => {
  h = await startHarness();
  payload = crypto.randomBytes(TOTAL);
  payloadDigest = sha256(payload);

  // Local service that hashes what it receives and answers with the digest on EOF.
  sinkServer = net.createServer({ allowHalfOpen: true }, (s) => {
    const hash = crypto.createHash('sha256');
    let n = 0;
    s.on('data', (c) => { hash.update(c); n += c.length; });
    s.on('end', () => s.end(`${hash.digest('hex')} ${n}`));
    s.on('error', () => {});
  });
  sinkPort = await listen(sinkServer);

  // Local service that sends the whole payload and closes.
  sourceServer = net.createServer((s) => {
    s.on('error', () => {});
    writeAll(s, payload).then(() => s.end(), () => {});
  });
  sourcePort = await listen(sourceServer);
});

after(async () => {
  for (const d of devices) await d.terminate().catch(() => {});
  await h.close();
  await closeServer(sinkServer);
  await closeServer(sourceServer);
});

test(`upload: ${TOTAL / MiB} MiB public -> device with sha256 integrity (v2)`, async (t) => {
  const d = await device();
  const reg = await d.register({ localPort: sinkPort, protocol: 'tcp' });
  const t0 = process.hrtime.bigint();
  const s = net.connect({ port: reg.allocatedPort, host: '127.0.0.1', allowHalfOpen: true });
  const reply = [];
  s.on('data', c => reply.push(c));
  await once(s, 'connect');
  await writeAll(s, payload);
  s.end();
  await once(s, 'end');
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const [digest, n] = Buffer.concat(reply).toString().split(' ');
  assert.equal(Number(n), TOTAL);
  assert.equal(digest, payloadDigest);
  const rate = TOTAL / MiB / secs;
  t.diagnostic(`upload throughput: ${rate.toFixed(1)} MB/s (${TOTAL / MiB} MiB in ${secs.toFixed(2)} s)`);
  assert.ok(rate >= MIN_MBPS, `throughput ${rate.toFixed(1)} MB/s below ${MIN_MBPS} MB/s`);
  await d.close();
});

test(`download: ${TOTAL / MiB} MiB device -> public with sha256 integrity (v2)`, async (t) => {
  const d = await device();
  const reg = await d.register({ localPort: sourcePort, protocol: 'tcp' });
  const t0 = process.hrtime.bigint();
  const s = net.connect(reg.allocatedPort, '127.0.0.1');
  const hash = crypto.createHash('sha256');
  let n = 0;
  s.on('data', (c) => { hash.update(c); n += c.length; });
  await once(s, 'end');
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  assert.equal(n, TOTAL);
  assert.equal(hash.digest('hex'), payloadDigest);
  const rate = TOTAL / MiB / secs;
  t.diagnostic(`download throughput: ${rate.toFixed(1)} MB/s (${TOTAL / MiB} MiB in ${secs.toFixed(2)} s)`);
  assert.ok(rate >= MIN_MBPS, `throughput ${rate.toFixed(1)} MB/s below ${MIN_MBPS} MB/s`);
  s.destroy();
  await d.close();
});

test('legacy v1 JSON/base64 data path keeps integrity (8 MiB both ways)', async () => {
  const d = await device({ protocol: 1 });
  const reg = await d.register({ localPort: sinkPort, protocol: 'tcp' });
  const part = payload.subarray(0, 8 * MiB);
  const s = net.connect({ port: reg.allocatedPort, host: '127.0.0.1', allowHalfOpen: true });
  const reply = [];
  s.on('data', c => reply.push(c));
  await once(s, 'connect');
  await writeAll(s, part);
  s.end();
  await once(s, 'end');
  assert.equal(Buffer.concat(reply).toString(), `${sha256(part)} ${part.length}`);
  await d.close();
});

test('slow public reader: the device is paused (tcp-pause) and buffering stays bounded', async (t) => {
  // Local service floods as fast as the tunnel lets it.
  let floodCtl = null;
  const floodServer = net.createServer((s) => { s.on('error', () => {}); floodCtl = flood(s); });
  const floodPort = await listen(floodServer);
  const d = await device();
  const reg = await d.register({ localPort: floodPort, protocol: 'tcp' });

  const pub = net.connect(reg.allocatedPort, '127.0.0.1');
  pub.on('error', () => {});
  await once(pub, 'connect');
  pub.pause(); // a client that does not read
  await waitUntil(() => floodCtl && d.received.tcpPause > 0, 5000, 'tcp-pause sent to the device');

  // Let the pipeline settle, then verify it is stalled (no growth) and bounded.
  await new Promise(r => setTimeout(r, 1000));
  const stalledAt = floodCtl.sent;
  const [stream] = channelOf(reg.tunnelId).streams.values();
  await new Promise(r => setTimeout(r, 700));
  assert.ok(floodCtl.sent - stalledAt <= MiB, `source kept sending: ${stalledAt} -> ${floodCtl.sent}`);
  assert.ok(floodCtl.sent < 48 * MiB, `too much in flight: ${(floodCtl.sent / MiB).toFixed(1)} MiB`);
  assert.ok(stream.readableLength <= STREAM_READ_HIGH_WATER + 16 * MiB,
    `server buffered ${stream.readableLength} bytes for one connection`);
  assert.ok(stream._pausedPeer, 'server asked the device to pause');
  t.diagnostic(`stalled after ${(stalledAt / MiB).toFixed(1)} MiB; server stream buffer ${(stream.readableLength / MiB).toFixed(2)} MiB`);

  // Reading again resumes the flow.
  let got = 0;
  pub.on('data', (c) => { got += c.length; });
  pub.resume();
  await waitUntil(() => got > stalledAt + 8 * MiB, 10_000, 'flow resumed');
  assert.ok(d.received.tcpResume > 0, 'tcp-resume sent');
  floodCtl.stop();
  pub.destroy();
  await d.close();
  await closeServer(floodServer);
});

test('slow local service: the public sender is paused and buffering stays bounded', async (t) => {
  // Local service that accepts but never reads.
  const stuck = [];
  const stuckServer = net.createServer({ pauseOnConnect: true }, (s) => { s.on('error', () => {}); stuck.push(s); });
  const stuckPort = await listen(stuckServer);
  const d = await device();
  const reg = await d.register({ localPort: stuckPort, protocol: 'tcp' });

  const pub = net.connect(reg.allocatedPort, '127.0.0.1');
  pub.on('error', () => {});
  await once(pub, 'connect');
  const ctl = flood(pub);
  const [stream] = await waitUntil(() => {
    const streams = [...channelOf(reg.tunnelId).streams.values()];
    return streams.length && streams[0]._remotePaused ? streams : null;
  }, 5000, 'device sent tcp-pause');

  await new Promise(r => setTimeout(r, 1000));
  const stalledAt = ctl.sent;
  await new Promise(r => setTimeout(r, 700));
  assert.ok(ctl.sent - stalledAt <= MiB, `public client kept sending: ${stalledAt} -> ${ctl.sent}`);
  assert.ok(ctl.sent < 48 * MiB, `too much in flight: ${(ctl.sent / MiB).toFixed(1)} MiB`);
  assert.ok(stream.writableLength <= 2 * MiB, `stream buffered ${stream.writableLength} bytes`);
  const ws = h.tunnelManager.getTunnel(reg.tunnelId).clientWs;
  assert.ok(ws.bufferedAmount < WS_HIGH_WATER, 'device WebSocket not flooded');
  t.diagnostic(`stalled after ${(stalledAt / MiB).toFixed(1)} MiB; stream write buffer ${stream.writableLength} B`);

  // The local service reads again -> tcp-resume -> the public client continues.
  for (const s of stuck) s.resume();
  await waitUntil(() => ctl.sent > stalledAt + 8 * MiB, 10_000, 'flow resumed');
  ctl.stop();
  pub.destroy();
  await d.close();
  for (const s of stuck) s.destroy();
  await closeServer(stuckServer);
});

test('congested device WebSocket: server stops reading public sockets above the high-water mark', async (t) => {
  const d = await device();
  const reg = await d.register({ localPort: sinkPort, protocol: 'tcp' });
  const ws = h.tunnelManager.getTunnel(reg.tunnelId).clientWs;
  const channel = ws.tunnelChannel;

  const pub = net.connect({ port: reg.allocatedPort, host: '127.0.0.1', allowHalfOpen: true });
  pub.on('error', () => {});
  await once(pub, 'connect');
  await waitUntil(() => channel.streams.size === 1, 3000, 'stream open');
  d.ws._socket.pause(); // the device stops reading its WebSocket

  const hash = crypto.createHash('sha256');
  const ctl = flood({
    get destroyed() { return pub.destroyed; },
    write(chunk) { hash.update(chunk); return pub.write(chunk); },
    once: (ev, fn) => pub.once(ev, fn),
  });
  await waitUntil(() => channel.congested, 5000, 'channel congested');
  await new Promise(r => setTimeout(r, 1000));
  const stalledAt = ctl.sent;
  await new Promise(r => setTimeout(r, 700));
  assert.ok(ctl.sent - stalledAt <= MiB, `public client kept sending: ${stalledAt} -> ${ctl.sent}`);
  assert.ok(ws.bufferedAmount <= WS_HIGH_WATER + 2 * MiB, `ws buffered ${ws.bufferedAmount}`);
  assert.ok(ctl.sent < 48 * MiB, `too much in flight: ${(ctl.sent / MiB).toFixed(1)} MiB`);
  t.diagnostic(`stalled after ${(stalledAt / MiB).toFixed(1)} MiB; ws.bufferedAmount ${(ws.bufferedAmount / MiB).toFixed(2)} MiB`);

  // Device reads again: everything arrives intact.
  ctl.stop();
  const reply = [];
  pub.on('data', c => reply.push(c));
  d.ws._socket.resume();
  pub.end();
  await once(pub, 'end');
  assert.equal(Buffer.concat(reply).toString(), `${hash.digest('hex')} ${ctl.sent}`);
  assert.equal(channel.congested, false);
  await d.close();
});
