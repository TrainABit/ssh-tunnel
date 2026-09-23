'use strict';

// Tunnel lifecycle over the /ws device protocol: register, tcp-open echo
// (v2 binary + v1 JSON), reconnect ownership, subdomain hijack protection,
// stable-port inheritance, standby, malformed input.
const { startHarness, listen, closeServer, waitUntil } = require('./helpers/core-harness');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('crypto');
const { FakeDevice } = require('./helpers/core-device');

let h;
let echoServer;
let echoPort;
const devices = [];

async function device(opts = {}) {
  const d = new FakeDevice({ url: h.wsUrl, token: h.authToken, ...opts });
  devices.push(d);
  await d.connect();
  return d;
}

/** Connect to a public TCP port, send payload, collect `expect` bytes back. */
function echoRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    let got = 0;
    sock.on('data', (c) => {
      chunks.push(c);
      got += c.length;
      if (got >= payload.length) {
        sock.end();
        resolve(Buffer.concat(chunks));
      }
    });
    sock.on('error', reject);
    sock.on('close', () => { if (got < payload.length) reject(new Error(`closed after ${got} bytes`)); });
    sock.write(payload);
  });
}

function connectRefused(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
}

before(async () => {
  h = await startHarness();
  echoServer = net.createServer((s) => s.pipe(s));
  echoPort = await listen(echoServer);
});

after(async () => {
  for (const d of devices) await d.terminate().catch(() => {});
  await h.close();
  await closeServer(echoServer);
});

test('server sends hello on connect', async () => {
  const d = await device();
  const hello = await d.waitFor(m => m.type === 'hello');
  assert.equal(hello.protocolVersion, 2);
  assert.deepEqual(hello.features, ['binary-data', 'flow-control']);
  await d.close();
});

test('register + tcp-open echo round trip (v2 binary frames)', async () => {
  const d = await device({ protocol: 2 });
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(reg.type, 'registered');
  assert.equal(reg.protocol, 'tcp');
  assert.ok(reg.allocatedPort >= h.tcpProxy.portMin && reg.allocatedPort <= h.tcpProxy.portMax);
  assert.equal(reg.localPort, echoPort);
  assert.match(reg.ownerSecret, /^[0-9a-f]{64}$/);
  assert.equal(reg.publicUrl, `tcp:${reg.allocatedPort}`);

  const ws = h.tunnelManager.getTunnel(reg.tunnelId).clientWs;
  assert.equal(ws.protocolVersion, 2);
  assert.equal(ws.tunnelChannel.binary, true);

  const payload = crypto.randomBytes(300 * 1024); // > one 256 KiB frame
  const back = await echoRoundTrip(reg.allocatedPort, payload);
  assert.ok(back.equals(payload));

  // connection accounting: sessions row with tunnel_id, tracker completed
  await waitUntil(() => h.db.queryOne(
    'SELECT * FROM sessions WHERE tunnel_id = ? AND disconnected_at IS NOT NULL', [reg.tunnelId]), 3000, 'session row closed');
  const t = h.tunnelManager.getTunnel(reg.tunnelId);
  assert.equal(t.connections, 1);
  assert.ok(t.bytesTransferred >= payload.length * 2);
  await d.close();
});

test('register + tcp-open echo round trip (legacy v1 JSON client)', async () => {
  const d = await device({ protocol: 1 });
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(reg.type, 'registered');
  const ws = h.tunnelManager.getTunnel(reg.tunnelId).clientWs;
  assert.equal(ws.protocolVersion, 1);
  assert.equal(ws.tunnelChannel.binary, false);
  const payload = crypto.randomBytes(200 * 1024);
  const back = await echoRoundTrip(reg.allocatedPort, payload);
  assert.ok(back.equals(payload));
  await d.close();
});

test('half-close: public FIN reaches the device, response still flows back', async () => {
  // Local service replies only after the client finished sending.
  const svc = net.createServer({ allowHalfOpen: true }, (s) => {
    const chunks = [];
    s.on('data', c => chunks.push(c));
    s.on('end', () => s.end(Buffer.concat(chunks).toString('utf8').toUpperCase()));
  });
  const svcPort = await listen(svc);
  const d = await device();
  const reg = await d.register({ localPort: svcPort, protocol: 'tcp' });
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect({ port: reg.allocatedPort, host: '127.0.0.1', allowHalfOpen: true });
    const chunks = [];
    s.on('data', c => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks).toString()));
    s.on('error', reject);
    s.end('hello half close');
  });
  assert.equal(reply, 'HELLO HALF CLOSE');
  await d.close();
  await closeServer(svc);
});

test('reconnect with ownerSecret keeps the tunnel and its public port', async () => {
  const token = h.createToken('reconnect-device');
  const d1 = await device({ token });
  const reg = await d1.register({ localPort: echoPort, protocol: 'tcp' });
  await d1.close();
  await waitUntil(() => h.tunnelManager.getTunnel(reg.tunnelId).status === 'inactive', 3000, 'inactive');
  assert.equal(await connectRefused(reg.allocatedPort), true, 'listener stops when the device disconnects');

  const d2 = await device({ token });
  const rec = await d2.reconnect(reg.tunnelId, reg.ownerSecret);
  assert.equal(rec.type, 'reconnected');
  assert.equal(rec.allocatedPort, reg.allocatedPort);
  assert.equal(rec.protocol, 'tcp');
  assert.equal(rec.localPort, echoPort);
  const payload = Buffer.from('still works');
  assert.ok((await echoRoundTrip(rec.allocatedPort, payload)).equals(payload));
  await d2.close();
});

test('reconnect is rejected with a wrong secret or from another token', async () => {
  const owner = h.createToken('owner');
  const other = h.createToken('other');
  const d1 = await device({ token: owner });
  const reg = await d1.register({ localPort: echoPort, protocol: 'tcp' });
  await d1.close();
  await waitUntil(() => h.tunnelManager.getTunnel(reg.tunnelId).status === 'inactive', 3000, 'inactive');

  const d2 = await device({ token: owner });
  const wrongSecret = await d2.reconnect(reg.tunnelId, 'f'.repeat(64));
  assert.equal(wrongSecret.type, 'error');
  assert.equal(wrongSecret.code, 'TUNNEL_NOT_FOUND');
  assert.equal(wrongSecret.tunnelId, reg.tunnelId);
  assert.equal(wrongSecret.message, 'Tunnel not found for reconnect');

  // Right secret, wrong token (e.g. a leaked state.json used with another device's token)
  const d3 = await device({ token: other });
  const wrongToken = await d3.reconnect(reg.tunnelId, reg.ownerSecret);
  assert.equal(wrongToken.type, 'error');
  assert.equal(wrongToken.code, 'TUNNEL_NOT_FOUND');
  assert.equal(wrongToken.tunnelId, reg.tunnelId);

  // Admin token cannot take over a device-token tunnel either
  const d4 = await device();
  const admin = await d4.reconnect(reg.tunnelId, reg.ownerSecret);
  assert.equal(admin.code, 'TUNNEL_NOT_FOUND');

  const t = h.tunnelManager.getTunnel(reg.tunnelId);
  assert.equal(t.status, 'inactive');
  assert.equal(t.clientWs, null);

  // Unknown tunnel id
  const unknownId = crypto.randomUUID();
  const unknown = await d2.reconnect(unknownId, reg.ownerSecret);
  assert.equal(unknown.code, 'TUNNEL_NOT_FOUND');
  assert.equal(unknown.tunnelId, unknownId);
  await Promise.all([d2.close(), d3.close(), d4.close()]);
});

test('client_token is persisted with the tunnel', async () => {
  const token = h.createToken('persist');
  const d = await device({ token });
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
  const row = h.db.queryOne('SELECT client_token, last_activity FROM tunnels WHERE id = ?', [reg.tunnelId]);
  assert.equal(row.client_token, token);
  assert.ok(row.last_activity);
  await d.close();
});

test('subdomain hijack is prevented across owners; the victim keeps its record', async () => {
  const victim = h.createToken('victim');
  const attacker = h.createToken('attacker');
  const dv = await device({ token: victim });
  const regV = await dv.register({ localPort: 8080, protocol: 'http', subdomain: 'shop' });
  assert.equal(regV.type, 'registered');
  assert.match(regV.publicUrl, /^http:\/\/shop\./);
  await dv.close();
  await waitUntil(() => h.tunnelManager.getTunnel(regV.tunnelId).status === 'inactive', 3000, 'inactive');

  const da = await device({ token: attacker });
  const regA = await da.register({ localPort: 8080, protocol: 'http', subdomain: 'shop' });
  assert.equal(regA.type, 'registered');
  assert.notEqual(regA.tunnelId, regV.tunnelId);
  const tA = h.tunnelManager.getTunnel(regA.tunnelId);
  assert.equal(tA.subdomain, 'shop-2');
  assert.ok(h.tunnelManager.getTunnel(regV.tunnelId), 'victim record not deleted');
  assert.equal(h.tunnelManager.getTunnelBySubdomain('shop').id, regV.tunnelId);

  // A third owner gets the next suffix
  const third = h.createToken('third');
  const dt = await device({ token: third });
  const regT = await dt.register({ localPort: 9000, protocol: 'http', subdomain: 'SHOP' });
  assert.equal(h.tunnelManager.getTunnel(regT.tunnelId).subdomain, 'shop-3');

  // The victim reconnects and gets its subdomain back
  const dv2 = await device({ token: victim });
  const rec = await dv2.reconnect(regV.tunnelId, regV.ownerSecret);
  assert.equal(rec.type, 'reconnected');
  assert.equal(h.tunnelManager.getTunnelBySubdomain('shop').id, regV.tunnelId);
  await Promise.all([da.close(), dt.close(), dv2.close()]);
});

test('getTunnelBySubdomain never matches tcp tunnels', async () => {
  const d = await device();
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp', name: 'sshbox' });
  assert.equal(h.tunnelManager.getTunnel(reg.tunnelId).subdomain, 'sshbox');
  assert.equal(h.tunnelManager.getTunnelBySubdomain('sshbox'), null);
  await d.close();
});

test('re-register by the same token inherits the stale record and its TCP port', async () => {
  const token = h.createToken('lost-state');
  const d1 = await device({ token });
  const reg1 = await d1.register({ localPort: echoPort, protocol: 'tcp' });
  await d1.close();
  await waitUntil(() => h.tunnelManager.getTunnel(reg1.tunnelId).status === 'inactive', 3000, 'inactive');

  // Occupy the "next free" port so a fresh allocation would differ.
  const d2 = await device({ token });
  const reg2 = await d2.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(reg2.type, 'registered');
  assert.notEqual(reg2.tunnelId, reg1.tunnelId);
  assert.equal(reg2.allocatedPort, reg1.allocatedPort, 'preferred port inherited');
  assert.equal(h.tunnelManager.getTunnel(reg1.tunnelId), null, 'stale record replaced');
  assert.equal(h.db.queryOne('SELECT id FROM tunnels WHERE id = ?', [reg1.tunnelId]), undefined);

  // A different token registering the same local port never replaces it
  const other = h.createToken('other-port-owner');
  const d3 = await device({ token: other });
  const reg3 = await d3.register({ localPort: echoPort, protocol: 'tcp' });
  assert.notEqual(reg3.allocatedPort, reg2.allocatedPort);
  assert.ok(h.tunnelManager.getTunnel(reg2.tunnelId));
  await Promise.all([d2.close(), d3.close()]);
});

test('an active record of the same token is never replaced', async () => {
  const token = h.createToken('two-conns');
  const d1 = await device({ token });
  const reg1 = await d1.register({ localPort: echoPort, protocol: 'tcp' });
  const d2 = await device({ token });
  const reg2 = await d2.register({ localPort: echoPort, protocol: 'tcp' });
  assert.notEqual(reg2.allocatedPort, reg1.allocatedPort);
  assert.equal(h.tunnelManager.getTunnel(reg1.tunnelId).status, 'active');
  await Promise.all([d1.close(), d2.close()]);
});

test('paused tunnels: reconnect gets standby and no listener; re-register inherits the pause', async () => {
  const token = h.createToken('pausable');
  const d1 = await device({ token });
  const reg = await d1.register({ localPort: echoPort, protocol: 'tcp' });
  // Emulate the dashboard toggle (routes/tunnels.js): pause + close WS
  const t = h.tunnelManager.getTunnel(reg.tunnelId);
  t.clientWs.close(1000, 'Tunnel paused');
  t.clientWs = null;
  t.status = 'paused';
  await d1.closed;
  await waitUntil(() => !h.tcpProxy.servers.has(reg.tunnelId), 3000, 'listener stop');
  assert.equal(h.tunnelManager.getTunnel(reg.tunnelId).status, 'paused');

  const d2 = await device({ token });
  const standby = await d2.reconnect(reg.tunnelId, reg.ownerSecret);
  assert.equal(standby.type, 'standby');
  assert.equal(h.tcpProxy.servers.has(reg.tunnelId), false);
  assert.equal(await connectRefused(reg.allocatedPort), true);
  await d2.close();
  await waitUntil(() => h.tunnelManager.getTunnel(reg.tunnelId).clientWs === null, 3000, 'detached');
  assert.equal(h.tunnelManager.getTunnel(reg.tunnelId).status, 'paused');

  // Device lost its state: re-registering the same port keeps it paused
  const d3 = await device({ token });
  const reg3 = await d3.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(reg3.type, 'registered');
  const sb = await d3.waitFor(m => m.type === 'standby' && m.tunnelId === reg3.tunnelId);
  assert.ok(sb);
  assert.equal(h.tunnelManager.getTunnel(reg3.tunnelId).status, 'paused');
  assert.equal(h.tcpProxy.servers.has(reg3.tunnelId), false);
  await d3.close();
});

test('removing a tunnel stops its public listener', async () => {
  const d = await device();
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(await connectRefused(reg.allocatedPort), false);
  h.tunnelManager.removeTunnel(reg.tunnelId);
  assert.equal(h.tcpProxy.servers.has(reg.tunnelId), false);
  await waitUntil(async () => connectRefused(reg.allocatedPort), 3000, 'port closed');
  await d.closed;
});

test('tcp-open to a dead local port: device tcp-close ends the public connection', async () => {
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await closeServer(dead);
  const d = await device();
  const reg = await d.register({ localPort: deadPort, protocol: 'tcp' });
  await new Promise((resolve, reject) => {
    const s = net.connect(reg.allocatedPort, '127.0.0.1');
    s.on('error', () => {});
    s.on('close', resolve);
    s.on('end', () => s.end());
    setTimeout(() => reject(new Error('public socket not closed')), 4000).unref();
  });
  await waitUntil(() => h.tunnelManager.getTunnel(reg.tunnelId).clientWs.tunnelChannel.size === 0, 3000, 'stream forgotten');
  await d.close();
});

test('malformed input never crashes the server and is answered with error codes', async () => {
  const d = await device();
  await d.waitFor(m => m.type === 'hello');
  d.sendRaw('not json');
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.sendRaw('[1,2,3]');
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.sendRaw('{"type":42}');
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.send({ type: 'launch-missiles' });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'UNKNOWN_TYPE');
  for (const localPort of [0, 70000, -1, 'abc', 1.5, null, { a: 1 }]) {
    d.send({ type: 'register', localPort, protocol: 'tcp' });
    assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_PORT');
  }
  d.send({ type: 'register', localPort: 22, protocol: 'udp' });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.send({ type: 'register', localPort: 22, protocol: 'tcp', name: { evil: true } });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.send({ type: 'reconnect', tunnelId: '../../etc', ownerSecret: 'x' });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.send({ type: 'tcp-close', connId: 'nope' });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  d.send({ type: 'tcp-data', connId: crypto.randomUUID(), data: 12 });
  assert.equal((await d.waitFor(m => m.type === 'error')).code, 'INVALID_MESSAGE');
  // Well-formed but unknown connIds are silently ignored
  d.send({ type: 'tcp-close', connId: crypto.randomUUID() });
  d.send({ type: 'tcp-pause', connId: crypto.randomUUID() });
  d.send({ type: 'tcp-data', connId: crypto.randomUUID(), data: 'aGVsbG8=' });
  // Binary junk: short frames, unknown types, unknown connIds, JSON inside binary
  d.sendRaw(Buffer.from([0x01, 0x02]), true);
  d.sendRaw(Buffer.alloc(0), true);
  d.sendRaw(Buffer.concat([Buffer.from([0x7f]), crypto.randomBytes(40)]), true);
  d.sendRaw(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(16), Buffer.from('x')]), true);
  d.sendRaw(Buffer.from(JSON.stringify({ type: 'register', localPort: 22, protocol: 'tcp' })), true);
  // Legacy response messages are ignored
  d.send({ type: 'response', id: 'x', statusCode: 200 });

  // Still alive and functional
  const reg = await d.register({ localPort: echoPort, protocol: 'tcp' });
  assert.equal(reg.type, 'registered');
  const payload = Buffer.from('ok');
  assert.ok((await echoRoundTrip(reg.allocatedPort, payload)).equals(payload));
  // Binary junk did not register anything
  assert.equal([...h.tunnelManager.tunnels.values()].filter(t => t.clientWs === h.tunnelManager.getTunnel(reg.tunnelId).clientWs).length, 1);
  await d.close();
});

test('too many protocol violations close the connection with 4001', async () => {
  const d = await device();
  for (let i = 0; i < 60; i++) d.sendRaw('garbage');
  const { code } = await d.closed;
  assert.equal(code, 4001);
});

test('frames above maxPayload (1 MiB) are refused without crashing', async () => {
  const d = await device();
  d.sendRaw(Buffer.alloc(1024 * 1024 + 100), true);
  const { code } = await d.closed;
  assert.equal(code, 1009);
  const d2 = await device();
  assert.equal((await d2.waitFor(m => m.type === 'hello')).type, 'hello');
  await d2.close();
});
