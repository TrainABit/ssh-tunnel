'use strict';

require('./helpers/platform-env');
// The logger reads LOG_LEVEL/LOG_FORMAT at require time: capture everything as JSON.
process.env.LOG_LEVEL = 'debug';
process.env.LOG_FORMAT = 'json';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const {
  createLogger, requestLogger, errorHandler, redactText, redactMeta, redactPath,
} = require('../src/logger');

const DEVICE_TOKEN = 'Zq7vB2mK9pL4xR8sT1wY';

/** Run fn while capturing our JSON log lines from stdout (the test runner's own output passes through). */
async function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"timestamp"')) {
      lines.push(chunk);
      return true;
    }
    return orig.call(this, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('');
}

describe('logger redaction', () => {
  test('redactText: query tokens, bearer, /api/tokens/<token>, gw-<token>', () => {
    assert.equal(redactText('GET /api/x?auth_token=abc123&y=1'), 'GET /api/x?auth_token=***&y=1');
    assert.equal(redactText('/ws?token=abc&ticket=def'), '/ws?token=***&ticket=***');
    assert.equal(redactText('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer ***');
    assert.equal(redactText(`PATCH /api/tokens/${DEVICE_TOKEN} 200`), 'PATCH /api/tokens/Zq7v*** 200');
    assert.equal(redactText(`user gw-${DEVICE_TOKEN} created`), 'user gw-Zq7v*** created');
    assert.equal(redactText('ws-handler started'), 'ws-handler started');
    assert.equal(redactPath('/api/sessions?active=1'), '/api/sessions?active=1');
  });

  test('redactMeta: sensitive keys, token keys, nested objects, errors', () => {
    const out = redactMeta({
      authorization: 'Bearer x',
      password: 'hunter2',
      passphrase: 'pp',
      private_key: '-----BEGIN',
      privateKey: '-----BEGIN',
      ownerSecret: 's3cr3t',
      cookie: 'tv_session=abc',
      sessionId: 'abcdef',
      session_id: 42,
      token: DEVICE_TOKEN,
      linux_user: `gw-${DEVICE_TOKEN}`,
      nested: { headers: { Cookie: 'x=y', 'set-cookie': ['a'] }, url: '/x?auth_token=zzz' },
      error: new Error(`failed for /api/tokens/${DEVICE_TOKEN}`),
      ip: '203.0.113.9',
      count: 3,
    });
    assert.equal(out.authorization, '[REDACTED]');
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.passphrase, '[REDACTED]');
    assert.equal(out.private_key, '[REDACTED]');
    assert.equal(out.privateKey, '[REDACTED]');
    assert.equal(out.ownerSecret, '[REDACTED]');
    assert.equal(out.cookie, '[REDACTED]');
    assert.equal(out.sessionId, '[REDACTED]');
    assert.equal(out.session_id, 42); // numeric row id: not a secret
    assert.equal(out.token, 'Zq7v***');
    assert.equal(out.linux_user, 'gw-Zq7v***');
    assert.equal(out.nested.headers.Cookie, '[REDACTED]');
    assert.equal(out.nested.headers['set-cookie'], '[REDACTED]');
    assert.equal(out.nested.url, '/x?auth_token=***');
    assert.ok(!out.error.message.includes(DEVICE_TOKEN));
    assert.ok(!out.error.stack.includes(DEVICE_TOKEN));
    assert.equal(out.ip, '203.0.113.9');
    assert.equal(out.count, 3);
    // cycles do not crash
    const a = { name: 'a' };
    a.self = a;
    assert.equal(redactMeta(a).self, '[Circular]');
  });

  test('log lines never contain secrets (message and meta)', async () => {
    const log = createLogger('test');
    const text = await captureStdout(() => {
      log.info(`Linux user gw-${DEVICE_TOKEN} created via /ws?auth_token=${DEVICE_TOKEN}`, {
        token: DEVICE_TOKEN, password: 'hunter2', headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      });
      log.error('boom', { error: new Error(`bad token ${'?token='}${DEVICE_TOKEN}`) });
    });
    assert.ok(text.length > 0);
    assert.ok(!text.includes(DEVICE_TOKEN), text);
    assert.ok(!text.includes('hunter2'));
    const first = JSON.parse(text.split('\n')[0]);
    assert.equal(first.token, 'Zq7v***');
    assert.equal(first.message, 'Linux user gw-Zq7v*** created via /ws?auth_token=***');
  });

  test('request log message and meta use the redacted path', async () => {
    const app = express();
    app.use(requestLogger());
    app.get('/api/tokens/:t', (_req, res) => res.json({ ok: true }));
    app.get('/api/fail', () => { throw new Error('kaputt'); });
    app.use(errorHandler());
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let text;
    try {
      text = await captureStdout(async () => {
        await (await fetch(`${base}/api/tokens/${DEVICE_TOKEN}?auth_token=${DEVICE_TOKEN}&ticket=T0PSECRET`)).text();
        await (await fetch(`${base}/api/fail?token=${DEVICE_TOKEN}`)).text();
        await new Promise((r) => setImmediate(r));
      });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    assert.ok(text.includes('/api/tokens/Zq7v***?auth_token=***&ticket=***'), text);
    assert.ok(!text.includes(DEVICE_TOKEN), text);
    assert.ok(!text.includes('T0PSECRET'), text);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    const reqLine = lines.find((l) => l.path && l.path.startsWith('/api/tokens/'));
    assert.equal(reqLine.message, 'GET /api/tokens/Zq7v***?auth_token=***&ticket=*** 200');
    const errLine = lines.find((l) => l.message === 'Unhandled route error');
    assert.equal(errLine.path, '/api/fail?token=***');
  });
});
