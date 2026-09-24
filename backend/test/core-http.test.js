'use strict';

// HTTP tunnels: streaming reverse proxy over tunnel streams, header rules,
// WebSocket upgrade passthrough and Host routing restricted to *.DOMAIN.
const { startHarness, listen, closeServer, waitUntil } = require('./helpers/core-harness');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { once } = require('events');
const WebSocket = require('ws');
const { FakeDevice } = require('./helpers/core-device');
const { createProxyServer, stripCookieDomain, stripDashboardCookies, hostnameOf, hostnameOfUrl } = require('../src/proxyServer');

const MiB = 1024 * 1024;

/** The application behind the device (listens on localhost). */
function createApp() {
  const state = { lastHeaders: null, upgradeHeaders: null, secondChunkSent: false, releaseStream: null };
  const server = http.createServer((req, res) => {
    state.lastHeaders = req.headers;
    switch (req.url.split('?')[0]) {
      case '/hello':
        res.end('hello from device');
        break;
      case '/headers':
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ headers: req.headers, url: req.url }));
        break;
      case '/cookies':
        res.setHeader('Set-Cookie', [
          'a=1; Domain=.test.local; Path=/; HttpOnly',
          // A device must not set (toss) the dashboard's session cookies.
          'tv_session=tossed; Path=/api',
          'b=2; path=/; domain=evil.example; Secure',
          ' __Host-tv_session =tossed; Path=/; Secure',
          'c=3',
        ]);
        res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
        res.setHeader('Public-Key-Pins', 'pin-sha256="x"; max-age=1');
        res.setHeader('Connection', 'X-Hop');
        res.setHeader('X-Hop', 'must-be-dropped');
        res.setHeader('X-Keep', 'yes');
        res.end('ok');
        break;
      case '/session-cookie-only':
        res.setHeader('Set-Cookie', 'tv_session=tossed; Path=/');
        res.end('ok');
        break;
      case '/stream':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('chunk-1;');
        state.releaseStream = () => {
          state.secondChunkSent = true;
          res.end('chunk-2');
        };
        break;
      case '/upload': {
        const hash = crypto.createHash('sha256');
        let n = 0;
        req.on('data', (c) => { hash.update(c); n += c.length; });
        req.on('end', () => res.end(JSON.stringify({ sha: hash.digest('hex'), n, te: req.headers['transfer-encoding'] || null })));
        break;
      }
      case '/big': {
        const block = Buffer.alloc(MiB);
        let i = 0;
        const pump = () => {
          while (i < 32) {
            block.fill(i);
            i++;
            if (!res.write(Buffer.from(block))) return res.once('drain', pump);
          }
          res.end();
        };
        res.writeHead(200, { 'content-length': String(32 * MiB) });
        pump();
        break;
      }
      case '/abort':
        res.writeHead(200, { 'content-length': '1000' });
        res.write('partial');
        setTimeout(() => res.socket.destroy(), 50);
        break;
      case '/hang':
        break; // never answers
      default:
        res.statusCode = 404;
        res.end('nope');
    }
  });
  const wss = new WebSocket.Server({ noServer: true });
  wss.on('headers', (headers) => {
    headers.push('Set-Cookie: ws=1; Domain=.test.local; Path=/');
    headers.push('Set-Cookie: tv_session=tossed; Path=/');
    headers.push('Strict-Transport-Security: max-age=1');
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  server.on('upgrade', (req, socket, head) => {
    state.upgradeHeaders = req.headers;
    if (req.url === '/deny') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nSet-Cookie: d=1; Domain=test.local\r\n'
        + 'Set-Cookie: __Host-tv_session=tossed; Path=/; Secure\r\n\r\ndenied');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return { server, wss, state };
}

function request(port, { host = 'app.test.local', path = '/hello', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

describe('HTTP tunnel proxy', () => {
  let h;
  let app;
  let appPort;
  let device;
  let reg;

  before(async () => {
    h = await startHarness({
      proxy: true,
      domain: 'test.local',
      idleTimeoutMs: 1500,
      // The dashboard (as the plain-HTTP installer prints it) and one more dashboard name under DOMAIN.
      publicUrl: 'http://198.51.100.7:4000',
      dashboardHost: 'dash.test.local',
    });
    app = createApp();
    appPort = await listen(app.server);
    device = new FakeDevice({ url: h.wsUrl, token: h.authToken });
    await device.connect();
    reg = await device.register({ localPort: appPort, protocol: 'http', subdomain: 'app' });
    assert.equal(reg.type, 'registered');
  });

  after(async () => {
    await device.terminate().catch(() => {});
    for (const c of app.wss.clients) c.terminate();
    await h.close();
    await closeServer(app.server);
  });

  test('registered http tunnel gets http://<subdomain>.<DOMAIN>:<PROXY_PORT>', () => {
    assert.equal(reg.publicUrl, `http://app.test.local:${process.env.PROXY_PORT || 4001}`);
    assert.equal(reg.allocatedPort, null);
  });

  test('routes by Host under .DOMAIN (case-insensitive, port and trailing dot stripped)', async () => {
    for (const host of ['app.test.local', 'APP.Test.Local:8080', 'app.test.local.']) {
      const r = await request(h.proxyPort, { host });
      assert.equal(r.status, 200, host);
      assert.equal(r.body.toString(), 'hello from device');
    }
  });

  test('no Host-based routing outside .DOMAIN', async () => {
    for (const host of ['app.evil.example', 'app', 'test.local', 'x.app.test.local', 'app.test.local.evil.example',
      'apptest.local', 'app.test.localhost', '[::1]', '']) {
      const r = await request(h.proxyPort, { host });
      assert.equal(r.status, 404, `Host "${host}" must not be routed`);
    }
  });

  test('?tunnel=<id> fallback only for http tunnels; tcp tunnels are never served', async () => {
    const r = await request(h.proxyPort, { host: 'elsewhere.example', path: `/hello?tunnel=${reg.tunnelId}` });
    assert.equal(r.status, 200);
    const tcpReg = await device.register({ localPort: appPort, protocol: 'tcp', name: 'tcpbox' });
    assert.equal(tcpReg.type, 'registered');
    assert.equal((await request(h.proxyPort, { host: 'tcpbox.test.local' })).status, 404);
    assert.equal((await request(h.proxyPort, { host: 'x.example', path: `/hello?tunnel=${tcpReg.tunnelId}` })).status, 404);
    assert.equal((await request(h.proxyPort, { host: 'x.example', path: '/hello?tunnel=../../etc' })).status, 404);
    // Never on our own names (dashboard host, unused or other tunnels' subdomains).
    for (const host of ['test.local', 'unused.test.local', 'tcpbox.test.local', 'x.app.test.local']) {
      assert.equal((await request(h.proxyPort, { host, path: `/hello?tunnel=${reg.tunnelId}` })).status, 404, host);
    }
  });

  test('?tunnel=<id> and Host routing are refused on the dashboard host (PUBLIC_URL / dashboardHost)', async () => {
    const path = `/hello?tunnel=${reg.tunnelId}`;
    // Same host as the dashboard at http://198.51.100.7:4000 (cookies are not port-scoped).
    for (const host of ['198.51.100.7:4001', '198.51.100.7', '198.51.100.7.:80']) {
      assert.equal((await request(h.proxyPort, { host, path })).status, 404, host);
    }
    // Other hosts outside DOMAIN keep the fallback.
    for (const host of ['198.51.100.8:4001', 'elsewhere.example']) {
      assert.equal((await request(h.proxyPort, { host, path })).status, 200, host);
    }
    // Upgrades too.
    const ws = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/chat?tunnel=${reg.tunnelId}`, { headers: { Host: '198.51.100.7:4001' } });
    ws.on('error', () => {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 404);
    ws.terminate();
    // A dashboard host under DOMAIN is not routed to a tunnel that registered that subdomain.
    const d = new FakeDevice({ url: h.wsUrl, token: h.authToken });
    await d.connect();
    try {
      const dashReg = await d.register({ localPort: appPort, protocol: 'http', subdomain: 'dash' });
      assert.equal(dashReg.type, 'registered');
      assert.equal((await request(h.proxyPort, { host: 'dash.test.local' })).status, 404);
      assert.equal((await request(h.proxyPort, { host: 'x.example', path: `/hello?tunnel=${dashReg.tunnelId}` })).status, 200);
    } finally {
      await d.close();
    }
  });

  test('dashboard session cookies are never forwarded to the device', async () => {
    const cookiesSeen = async (headers) => {
      const r = await request(h.proxyPort, { path: '/headers', headers });
      assert.equal(r.status, 200);
      return JSON.parse(r.body.toString()).headers.cookie;
    };
    assert.equal(await cookiesSeen({ Cookie: 'a=1; tv_session=X; __Host-tv_session=Y; b=2' }), 'a=1; b=2');
    assert.equal(await cookiesSeen({ Cookie: 'tv_session=X' }), undefined, 'no Cookie header left');
    assert.equal(await cookiesSeen({ Cookie: '__Host-tv_session=Y;tv_session=X' }), undefined);
    // Several Cookie header lines (joined by the server) are filtered the same way.
    assert.equal(await cookiesSeen({ Cookie: ['a=1; tv_session=X', '__Host-tv_session=Y; b=2'] }), 'a=1; b=2');
    // Names are case-sensitive; similar names are not the dashboard's cookies.
    assert.equal(await cookiesSeen({ Cookie: 'TV_SESSION=1; tv_session2=2; x_tv_session=3' }),
      'TV_SESSION=1; tv_session2=2; x_tv_session=3');
    assert.equal(await cookiesSeen({ Cookie: 'plain=1' }), 'plain=1');
    // Also through the ?tunnel= fallback (the case where a browser would really send them).
    const r = await request(h.proxyPort, {
      host: '198.51.100.8:4001', path: `/headers?tunnel=${reg.tunnelId}`, headers: { Cookie: 'tv_session=X; keep=1' },
    });
    assert.equal(JSON.parse(r.body.toString()).headers.cookie, 'keep=1');
  });

  test('dashboard session cookies are never forwarded on WebSocket upgrades', async () => {
    const upgradeCookie = async (cookie) => {
      app.state.upgradeHeaders = null;
      const ws = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/chat`, { headers: { Host: 'app.test.local', Cookie: cookie } });
      await once(ws, 'open');
      const seen = app.state.upgradeHeaders.cookie;
      ws.close();
      await once(ws, 'close');
      return seen;
    };
    assert.equal(await upgradeCookie('a=1; tv_session=X; __Host-tv_session=Y; b=2'), 'a=1; b=2');
    assert.equal(await upgradeCookie('tv_session=X'), undefined);
  });

  test('forwarding headers are regenerated (untrusted peer cannot spoof them)', async () => {
    const r = await request(h.proxyPort, {
      path: '/headers',
      headers: {
        'X-Forwarded-For': '6.6.6.6',
        'X-Real-IP': '6.6.6.6',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'https',
        Forwarded: 'for=6.6.6.6',
        'Proxy-Authorization': 'Basic abc',
        'X-App': 'kept',
      },
    });
    const { headers } = JSON.parse(r.body.toString());
    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(headers['x-real-ip'], '127.0.0.1');
    assert.equal(headers['x-forwarded-host'], 'app.test.local');
    assert.equal(headers['x-forwarded-proto'], 'http');
    assert.equal(headers.forwarded, undefined);
    assert.equal(headers['proxy-authorization'], undefined);
    assert.equal(headers.host, 'app.test.local');
    assert.equal(headers['x-app'], 'kept');
    assert.equal(headers.connection, 'close');
  });

  test('response headers: Set-Cookie passes with Domain stripped (dashboard session cookies dropped); HSTS/HPKP and hop-by-hop dropped', async () => {
    const r = await request(h.proxyPort, { path: '/cookies' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/; HttpOnly', 'b=2; path=/; Secure', 'c=3']);
    const only = await request(h.proxyPort, { path: '/session-cookie-only' });
    assert.equal(only.status, 200);
    assert.equal(only.headers['set-cookie'], undefined);
    assert.equal(r.headers['strict-transport-security'], undefined);
    assert.equal(r.headers['public-key-pins'], undefined);
    assert.equal(r.headers['x-hop'], undefined);
    assert.equal(r.headers['x-keep'], 'yes');
  });

  test('response bodies are streamed, not buffered', async () => {
    app.state.secondChunkSent = false;
    const req = http.request({ host: '127.0.0.1', port: h.proxyPort, path: '/stream', agent: false, headers: { host: 'app.test.local' } });
    req.end();
    const [res] = await once(req, 'response');
    const [first] = await once(res, 'data');
    assert.equal(first.toString(), 'chunk-1;');
    assert.equal(app.state.secondChunkSent, false, 'first chunk arrived before the app finished');
    const rest = [];
    res.on('data', c => rest.push(c));
    app.state.releaseStream();
    await once(res, 'end');
    assert.equal(Buffer.concat(rest).toString(), 'chunk-2');
  });

  test('large request bodies stream through (chunked and content-length) with integrity', async () => {
    const body = crypto.randomBytes(16 * MiB);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    // chunked upload, written in pieces
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.proxyPort, path: '/upload', method: 'POST', agent: false,
        headers: { host: 'app.test.local', 'transfer-encoding': 'chunked' } }, (res) => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      });
      req.on('error', reject);
      (async () => {
        for (let off = 0; off < body.length; off += MiB) {
          if (!req.write(body.subarray(off, off + MiB))) await once(req, 'drain');
        }
        req.end();
      })();
    });
    assert.deepEqual(chunked, { sha, n: body.length, te: 'chunked' });
    const fixed = await request(h.proxyPort, { path: '/upload', method: 'POST', body, headers: { 'content-length': String(body.length) } });
    assert.deepEqual(JSON.parse(fixed.body.toString()), { sha, n: body.length, te: null });
  });

  test('large responses stream through with integrity', async () => {
    const r = await request(h.proxyPort, { path: '/big' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 32 * MiB);
    for (let i = 0; i < 32; i++) assert.equal(r.body[i * MiB + 12345], i);
  });

  test('a device-side abort mid-body aborts the client response (no silent truncation)', async () => {
    const req = http.request({ host: '127.0.0.1', port: h.proxyPort, path: '/abort', agent: false, headers: { host: 'app.test.local' } });
    req.on('error', () => {});
    req.end();
    const [res] = await once(req, 'response');
    assert.equal(res.statusCode, 200);
    let errored = false;
    res.on('data', () => {});
    res.on('error', () => { errored = true; });
    await new Promise(resolve => res.on('close', resolve));
    assert.equal(res.complete, false);
    assert.ok(errored || res.aborted, 'client sees an aborted response');
  });

  test('idle timeout -> 504 when the device app does not answer', async () => {
    const t0 = Date.now();
    const r = await request(h.proxyPort, { path: '/hang' });
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t0 >= 1000);
  });

  test('WebSocket upgrade passthrough (text + 1 MiB binary), 101 headers filtered', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/chat`, { headers: { Host: 'app.test.local', 'X-Forwarded-For': '6.6.6.6' } });
    const upgraded = once(ws, 'upgrade');
    const opened = once(ws, 'open'); // emitted right after 'upgrade'
    const [res] = await upgraded;
    assert.deepEqual(res.headers['set-cookie'], ['ws=1; Path=/']);
    assert.equal(res.headers['strict-transport-security'], undefined);
    await opened;
    assert.equal(app.state.upgradeHeaders['x-forwarded-for'], '127.0.0.1');
    assert.equal(app.state.upgradeHeaders['x-forwarded-host'], 'app.test.local');
    assert.equal(app.state.upgradeHeaders.host, 'app.test.local');

    ws.send('hello ws');
    const [text, isBinary] = await once(ws, 'message');
    assert.equal(isBinary, false);
    assert.equal(text.toString(), 'hello ws');
    const blob = crypto.randomBytes(MiB);
    ws.send(blob);
    const [echo, bin] = await once(ws, 'message');
    assert.equal(bin, true);
    assert.ok(Buffer.from(echo).equals(blob));
    ws.close();
    await once(ws, 'close');
  });

  test('a declined upgrade is relayed as a normal response', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/deny`, { headers: { Host: 'app.test.local' } });
    ws.on('error', () => {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.headers['set-cookie'], ['d=1']);
    const body = [];
    res.on('data', c => body.push(c));
    await once(res, 'end');
    assert.equal(Buffer.concat(body).toString(), 'denied');
    ws.terminate();
  });

  test('upgrade for an unknown host is rejected with 404', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/chat`, { headers: { Host: 'nope.test.local' } });
    ws.on('error', () => {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 404);
    ws.terminate();
  });

  test('requests are counted per tunnel; offline tunnels answer 502', async () => {
    const t = h.tunnelManager.getTunnel(reg.tunnelId);
    const before = t.connections;
    const bytesBefore = t.bytesTransferred;
    await request(h.proxyPort);
    assert.equal(t.connections, before + 1);
    assert.ok(t.bytesTransferred > bytesBefore);
    await waitUntil(() => h.connectionTracker.getConnections(reg.tunnelId).length === 0, 3000, 'tracker cleaned up');

    const d2 = new FakeDevice({ url: h.wsUrl, token: h.authToken });
    await d2.connect();
    const reg2 = await d2.register({ localPort: appPort, protocol: 'http', subdomain: 'offline' });
    assert.equal((await request(h.proxyPort, { host: 'offline.test.local' })).status, 200);
    await d2.close();
    await waitUntil(() => h.tunnelManager.getTunnel(reg2.tunnelId).status === 'inactive', 3000, 'inactive');
    assert.equal((await request(h.proxyPort, { host: 'offline.test.local' })).status, 502);
  });
});

describe('HTTP tunnel proxy behind a trusted reverse proxy', () => {
  let h;
  let app;
  let device;

  before(async () => {
    h = await startHarness({ proxy: true, domain: 'test.local', trustProxy: 'loopback' });
    app = createApp();
    const appPort = await listen(app.server);
    device = new FakeDevice({ url: h.wsUrl, token: h.authToken });
    await device.connect();
    await device.register({ localPort: appPort, protocol: 'http', subdomain: 'app' });
  });

  after(async () => {
    await device.terminate().catch(() => {});
    await h.close();
    await closeServer(app.server);
  });

  test('X-Forwarded-* from a trusted proxy are honoured and extended', async () => {
    const r = await request(h.proxyPort, {
      path: '/headers',
      headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'app.test.local' },
    });
    const { headers } = JSON.parse(r.body.toString());
    assert.equal(headers['x-forwarded-for'], '203.0.113.9, 127.0.0.1');
    assert.equal(headers['x-real-ip'], '203.0.113.9');
    assert.equal(headers['x-forwarded-proto'], 'https');
  });
});

test('stripCookieDomain / hostnameOf helpers', () => {
  assert.equal(stripCookieDomain('sid=abc; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=Lax'),
    'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax');
  assert.equal(stripCookieDomain('x=1;domain=a.b;DOMAIN=c.d'), 'x=1');
  assert.equal(stripCookieDomain('x=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'), 'x=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  assert.equal(hostnameOf('App.Test.Local:4001'), 'app.test.local');
  assert.equal(hostnameOf('[::1]:80'), '[::1]');
  assert.equal(hostnameOf(undefined), '');
  assert.equal(hostnameOfUrl('https://Tunnel.Example.com:8443/dash'), 'tunnel.example.com');
  assert.equal(hostnameOfUrl('http://[::1]:4000'), '[::1]');
  assert.equal(hostnameOfUrl('http://198.51.100.7:4000/'), '198.51.100.7');
  assert.equal(hostnameOfUrl('dash.example.com:4000'), 'dash.example.com');
  assert.equal(hostnameOfUrl('https://'), '');
  assert.equal(hostnameOfUrl(null), '');
});

test('stripDashboardCookies', () => {
  assert.equal(stripDashboardCookies('a=1; tv_session=X; __Host-tv_session=Y; b=2'), 'a=1; b=2');
  assert.equal(stripDashboardCookies('tv_session=X'), undefined);
  assert.equal(stripDashboardCookies(' tv_session = X ;; '), undefined);
  assert.equal(stripDashboardCookies(['a=1; tv_session=X', '__Host-tv_session=Y', 'b=2']), 'a=1; b=2');
  assert.equal(stripDashboardCookies(['tv_session=X', '__Host-tv_session=Y']), undefined);
  assert.equal(stripDashboardCookies('Tv_Session=1;a=2'), 'Tv_Session=1; a=2');
  assert.equal(stripDashboardCookies(''), undefined);
  assert.equal(stripDashboardCookies(undefined), undefined);
});

test('PUBLIC_URL (env) is the dashboard host when no publicUrl option is given', async (t) => {
  const h = await startHarness({ proxy: false });
  const app = createApp();
  const appPort = await listen(app.server);
  const saved = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://Dash.Example.org';
  let proxy;
  let device;
  t.after(async () => {
    if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved;
    if (device) await device.terminate().catch(() => {});
    await closeServer(proxy);
    await h.close();
    await closeServer(app.server);
  });
  proxy = createProxyServer(h.tunnelManager, h.connectionTracker, { tcpProxy: h.tcpProxy, domain: 'test.local' });
  const proxyPort = await listen(proxy);
  device = new FakeDevice({ url: h.wsUrl, token: h.authToken });
  await device.connect();
  const reg = await device.register({ localPort: appPort, protocol: 'http', subdomain: 'envapp' });
  const path = `/hello?tunnel=${reg.tunnelId}`;
  assert.equal((await request(proxyPort, { host: 'dash.example.org', path })).status, 404);
  assert.equal((await request(proxyPort, { host: 'other.example.org', path })).status, 200);
});
