import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CLIENT_VERSION,
  FRAME_DATA,
  FRAME_HEADER_LENGTH,
  buildWsUrl,
  bytesToUuid,
  decodeFrame,
  encodeDataFrame,
  isInsecureRemoteUrl,
  isLocalOrPrivateHost,
  normalizeConnId,
  sanitizeText,
  uuidToBytes,
} from '../src/protocol.js';
import { resolveAllowReboot } from '../src/tunnel.js';

test('client version is 2.0.0 and matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  assert.equal(CLIENT_VERSION, '2.0.0');
  assert.equal(pkg.version, CLIENT_VERSION);
});

test('uuid <-> 16 raw bytes round trip', () => {
  const id = randomUUID();
  const bytes = uuidToBytes(id);
  assert.equal(bytes.length, 16);
  assert.equal(bytesToUuid(bytes), id);
  assert.equal(bytesToUuid(uuidToBytes(id.toUpperCase())), id);
  assert.throws(() => uuidToBytes('not-a-uuid'), TypeError);
});

test('DATA frame encode/decode', () => {
  const id = randomUUID();
  const payload = Buffer.from('hello äöü');
  const frame = encodeDataFrame(id, payload);
  assert.equal(frame[0], FRAME_DATA);
  assert.equal(frame.length, FRAME_HEADER_LENGTH + payload.length);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, FRAME_DATA);
  assert.equal(decoded.connId, id);
  assert.deepEqual(decoded.payload, payload);

  // header-only frame is valid (empty payload); anything shorter is ignored
  assert.equal(decodeFrame(encodeDataFrame(id, Buffer.alloc(0))).payload.length, 0);
  assert.equal(decodeFrame(Buffer.alloc(16)), null);
  assert.equal(decodeFrame('not a buffer'), null);
  // unknown types decode but carry their type so receivers can ignore them
  const unknown = Buffer.from(frame);
  unknown[0] = 0x7f;
  assert.equal(decodeFrame(unknown).type, 0x7f);
});

test('normalizeConnId', () => {
  const id = randomUUID();
  assert.equal(normalizeConnId(id.toUpperCase()), id);
  assert.equal(normalizeConnId('legacy-id-1'), 'legacy-id-1');
  assert.equal(normalizeConnId(''), null);
  assert.equal(normalizeConnId(42), null);
  assert.equal(normalizeConnId('a'.repeat(129)), null);
  assert.equal(normalizeConnId('bad\nid'), null);
});

test('sanitizeText strips control characters and caps length', () => {
  assert.equal(sanitizeText('\u001b[2Jhello\r\nworld\u0007'), '[2Jhelloworld');
  assert.equal(sanitizeText('x'.repeat(10), 4), 'xxxx…');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(1234), '1234');
});

test('buildWsUrl normalises server URLs', () => {
  assert.equal(buildWsUrl('ws://host:4000').url, 'ws://host:4000/ws');
  assert.equal(buildWsUrl('ws://host:4000/').url, 'ws://host:4000/ws');
  assert.equal(buildWsUrl('ws://host:4000/ws').url, 'ws://host:4000/ws');
  assert.equal(buildWsUrl('ws://host:4000/ws/').url, 'ws://host:4000/ws');
  assert.equal(buildWsUrl('wss://example.com/prefix').url, 'wss://example.com/prefix/ws');
  assert.equal(buildWsUrl('https://example.com').url, 'wss://example.com/ws');
  assert.equal(buildWsUrl('http://10.0.0.5:4000').url, 'ws://10.0.0.5:4000/ws');

  const legacy = buildWsUrl('ws://host:4000/?auth_token=secret123');
  assert.equal(legacy.url, 'ws://host:4000/ws');
  assert.equal(legacy.tokenFromQuery, 'secret123');
  assert.equal(buildWsUrl('ws://host:4000').tokenFromQuery, null);

  assert.throws(() => buildWsUrl('ftp://host'), TypeError);
  assert.throws(() => buildWsUrl('not a url'), TypeError);
  assert.throws(() => buildWsUrl('ws://user:pw@host'), TypeError);
  // Error messages never echo credentials or query strings (they may hold a token).
  for (const bad of ['wss://h:99999/?auth_token=SECRET', 'ws://user:SECRET@h:99999/x', 'ws://h:99999/#SECRET']) {
    assert.throws(() => buildWsUrl(bad), (err) => err instanceof TypeError && !err.message.includes('SECRET'));
  }
});

test('local / private host detection', () => {
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', '127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1',
    '172.31.255.255', '192.168.1.10', '169.254.1.1', '[::1]', '::1', 'fd00::1', 'fe80::1', '[::ffff:7f00:1]',
    '::ffff:192.168.0.1', 'pi.local', 'nas.home.arpa', 'box.lan', 'db.internal']) {
    assert.equal(isLocalOrPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '100.64.0.1', '2001:db8::1',
    '[::ffff:808:808]', 'localhost.example.com', '']) {
    assert.equal(isLocalOrPrivateHost(h), false, h);
  }
});

test('plaintext warning only for ws:// to non-local hosts', () => {
  assert.equal(isInsecureRemoteUrl('ws://example.com:4000/ws'), true);
  assert.equal(isInsecureRemoteUrl('ws://203.0.113.7:4000/ws'), true);
  assert.equal(isInsecureRemoteUrl('wss://example.com/ws'), false);
  assert.equal(isInsecureRemoteUrl('ws://localhost:4000/ws'), false);
  assert.equal(isInsecureRemoteUrl('ws://192.168.0.2:4000/ws'), false);
});

test('resolveAllowReboot: opt-in via config or env, env wins', () => {
  assert.equal(resolveAllowReboot({}, {}), false);
  assert.equal(resolveAllowReboot({ allow_reboot: 'yes' }, {}), false, 'only boolean true enables it');
  assert.equal(resolveAllowReboot({ allow_reboot: true }, {}), true);
  assert.equal(resolveAllowReboot({}, { TUNNELVAULT_ALLOW_REBOOT: '1' }), true);
  assert.equal(resolveAllowReboot({}, { TUNNELVAULT_ALLOW_REBOOT: 'true' }), true);
  assert.equal(resolveAllowReboot({ allow_reboot: true }, { TUNNELVAULT_ALLOW_REBOOT: '0' }), false);
  assert.equal(resolveAllowReboot({}, { TUNNELVAULT_ALLOW_REBOOT: 'maybe' }), false);
  assert.equal(resolveAllowReboot(null, {}), false);
});
