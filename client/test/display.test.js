import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Display, QuietDisplay } from '../src/display.js';

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

test('non-interactive display (journald): plain lines, only on change, server strings sanitised', () => {
  const out = sink();
  const err = sink();
  const d = new Display({ interactive: false, out, err });
  d.startSpinner('Connecting to wss://example.test/ws...');
  const lines = [{ name: 'ssh', port: 22, public: 'public port 10022' }, { name: 'web\u001b[2J', port: 80, status: 'registering…' }];
  d.setConnectedMulti(lines);
  d.setConnectedMulti(lines); // unchanged -> nothing new printed
  d.warn('evil \u001b]0;title\u0007 text');
  d.error('boom');
  d.logRequest('GET', '/x\r\ny', 200, 'OK', 5);
  d.setDisconnected('code 1006');
  d.setReconnecting(2, 30000);
  d.destroy();

  const text = out.text();
  assert.match(text, /Connecting to wss:\/\/example\.test\/ws/);
  assert.equal(text.match(/Connected to tunnel server/g).length, 1);
  assert.equal(text.match(/ssh :22 -> public port 10022/g).length, 1);
  assert.match(text, /web\[2J :80 -> registering/);
  assert.match(text, /GET \/xy 200 OK 5ms/);
  assert.match(text, /Disconnected: code 1006/);
  assert.match(text, /Reconnecting \(attempt 2\) in 30s/);
  assert.doesNotMatch(text, /EC2/);
  assert.match(err.text(), /WARN: evil \]0;title text/);
  assert.match(err.text(), /ERROR: boom/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(out.text() + err.text(), /[\u0000-\u0008\u000b-\u001f\u007f]/, 'no control characters except newlines');
});

test('interactive display renders the status box with version 2.0.0 and sanitised values', () => {
  const out = sink();
  const err = sink();
  const d = new Display({ interactive: true, out, err });
  d.setConnectedMulti([{ name: 'ssh', port: 22, public: 'public port 10022\u001b[31m' }]);
  d.warn('careful');
  d.setDisconnected('gone\u001b[2J');
  d.setReconnecting(3, 2000);
  d.destroy();
  const text = out.text();
  assert.match(text, /Disconnected: gone\[2J/);
  assert.match(text, /Reconnecting \(attempt 3\) in 2s/);
  assert.match(text, /TunnelVault/);
  assert.match(text, /v2\.0\.0/);
  assert.match(text, /public port 10022/);
  assert.doesNotMatch(text, /10022\u001b\[31m/, 'server-supplied escape sequences are stripped');
  assert.match(text, /careful/);
});

test('QuietDisplay implements the full display interface silently', () => {
  const logs = [];
  const q = new QuietDisplay({ onLog: (level, message) => logs.push([level, message]) });
  for (const method of ['startSpinner', 'stopSpinner', 'setConnected', 'setConnectedMulti', 'setDisconnected',
    'setReconnecting', 'logRequest', 'info', 'warn', 'error', 'render', 'destroy']) {
    assert.equal(typeof q[method], 'function', method);
    assert.equal(typeof Display.prototype[method], 'function', `Display.${method}`);
  }
  q.warn('w');
  q.error('e');
  assert.deepEqual(logs, [['warn', 'w'], ['error', 'e']]);
});
