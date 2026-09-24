import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceServerUrl, publicHostname, isInsecurePublicUrl, shellQuote, isHttpUrl, tcpOpenUrl, tcpAddress, isHttpsDashboard } from '../src/utils/serverUrl.js';

const httpsLoc = { protocol: 'https:', host: 'tunnel.example.com', hostname: 'tunnel.example.com' };
const httpLoc = { protocol: 'http:', host: '203.0.113.7:4000', hostname: '203.0.113.7' };

test('deviceServerUrl prefers PUBLIC_URL and maps https->wss, http->ws', () => {
  assert.equal(deviceServerUrl({ publicUrl: 'https://tunnel.example.com' }, httpLoc), 'wss://tunnel.example.com');
  assert.equal(deviceServerUrl({ publicUrl: 'https://tunnel.example.com/' }, httpLoc), 'wss://tunnel.example.com');
  assert.equal(deviceServerUrl({ publicUrl: 'https://tunnel.example.com:8443' }, httpLoc), 'wss://tunnel.example.com:8443');
  assert.equal(deviceServerUrl({ publicUrl: 'http://10.0.0.5:4000' }, httpsLoc), 'ws://10.0.0.5:4000');
  assert.equal(deviceServerUrl({ publicUrl: 'https://example.com/tv/' }, httpLoc), 'wss://example.com/tv');
});

test('deviceServerUrl falls back to the page location (wss on https, host incl. port)', () => {
  assert.equal(deviceServerUrl(null, httpsLoc), 'wss://tunnel.example.com');
  assert.equal(deviceServerUrl({ publicUrl: null }, httpLoc), 'ws://203.0.113.7:4000');
  assert.equal(deviceServerUrl({ publicUrl: '' }, httpLoc), 'ws://203.0.113.7:4000');
  assert.equal(deviceServerUrl({ publicUrl: 'not a url' }, httpsLoc), 'wss://tunnel.example.com');
  assert.equal(deviceServerUrl({ publicUrl: 'ftp://x.example' }, httpsLoc), 'wss://tunnel.example.com');
  // Never a hardcoded :4000 on https
  assert.ok(!deviceServerUrl(undefined, httpsLoc).includes(':4000'));
});

test('publicHostname uses PUBLIC_URL host, else the page hostname', () => {
  assert.equal(publicHostname({ publicUrl: 'https://tunnel.example.com:8443/x' }, httpLoc), 'tunnel.example.com');
  assert.equal(publicHostname(null, httpLoc), '203.0.113.7');
});

test('isInsecurePublicUrl flags plaintext URLs to public hosts only', () => {
  assert.equal(isInsecurePublicUrl('ws://203.0.113.7:4000'), true);
  assert.equal(isInsecurePublicUrl('http://tunnel.example.com'), true);
  assert.equal(isInsecurePublicUrl('wss://tunnel.example.com'), false);
  assert.equal(isInsecurePublicUrl('https://tunnel.example.com'), false);
  for (const local of ['ws://localhost:4000', 'ws://127.0.0.1:4000', 'http://192.168.1.10', 'ws://10.1.2.3',
    'ws://172.16.0.1', 'ws://172.31.255.1', 'http://[::1]:4000', 'ws://pi.localhost']) {
    assert.equal(isInsecurePublicUrl(local), false, local);
  }
  assert.equal(isInsecurePublicUrl('ws://172.32.0.1'), true);
  assert.equal(isInsecurePublicUrl('garbage'), false);
});

test('shellQuote leaves safe values alone and single-quotes the rest', () => {
  assert.equal(shellQuote('wss://tunnel.example.com'), 'wss://tunnel.example.com');
  assert.equal(shellQuote('ws://10.0.0.1:4000/path'), 'ws://10.0.0.1:4000/path');
  assert.equal(shellQuote('wss://x/$(id)'), "'wss://x/$(id)'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('isHttpUrl only accepts absolute http(s) URLs', () => {
  assert.equal(isHttpUrl('https://web.tunnel.example.com'), true);
  assert.equal(isHttpUrl('http://203.0.113.7:10002'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('/relative'), false);
  assert.equal(isHttpUrl(null), false);
});

test('tcpOpenUrl: no clickable http:// link over HTTPS (HSTS covers every port of the host)', () => {
  // Dashboard served over HTTPS, or PUBLIC_URL is https:// (--tls): no link.
  assert.equal(tcpOpenUrl({ publicUrl: 'https://tunnel.example.com' }, 8080, httpsLoc), null);
  assert.equal(tcpOpenUrl(null, 8080, httpsLoc), null);
  assert.equal(tcpOpenUrl({ publicUrl: 'https://tunnel.example.com' }, 8080, httpLoc), null);
  assert.equal(isHttpsDashboard({ publicUrl: 'HTTPS://tunnel.example.com' }, httpLoc), true);
  // Plain-HTTP mode keeps the link.
  assert.equal(tcpOpenUrl({ publicUrl: 'http://203.0.113.7:4000' }, 8080, httpLoc), 'http://203.0.113.7:8080');
  assert.equal(tcpOpenUrl(null, '9000', httpLoc), 'http://203.0.113.7:9000');
  assert.equal(isHttpsDashboard(null, httpLoc), false);
  // Invalid ports never produce a link.
  assert.equal(tcpOpenUrl(null, null, httpLoc), null);
  assert.equal(tcpOpenUrl(null, 70000, httpLoc), null);
});

test('tcpAddress is host:port of the public hostname (IPv6 in brackets)', () => {
  assert.equal(tcpAddress({ publicUrl: 'https://tunnel.example.com' }, 8080, httpLoc), 'tunnel.example.com:8080');
  assert.equal(tcpAddress(null, 8080, httpLoc), '203.0.113.7:8080');
  assert.equal(tcpAddress({ publicUrl: 'http://[2001:db8::1]:4000' }, 8080, httpLoc), '[2001:db8::1]:8080');
  assert.equal(tcpAddress(null, 22, { protocol: 'http:', host: 'x', hostname: '2001:db8::2' }), '[2001:db8::2]:22');
});
