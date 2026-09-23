// End-to-end tests of `tunnelvault connect` (bin/tunnelvault.js) against a fake server.
// Reboot commands are resolved through a PATH that contains only fake `sudo`,
// `systemctl` and `reboot` scripts, so nothing here can reboot the machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const BIN = fileURLToPath(new URL('../bin/tunnelvault.js', import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'tv-cli-test-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Fake reboot binaries: record the invocation instead of rebooting.
const fakeBin = join(tmpRoot, 'fakebin');
const marker = join(tmpRoot, 'reboot-calls.log');
mkdirSync(fakeBin);
for (const name of ['sudo', 'systemctl', 'reboot']) {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "$TV_TEST_MARKER"\nexit 0\n`, { mode: 0o755 });
}

async function startServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const seen = { upgrades: [], messages: [] };
  wss.on('connection', (ws, req) => {
    seen.upgrades.push({ url: req.url, headers: req.headers });
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, features: ['binary-data', 'flow-control'] }));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      seen.messages.push(msg);
      if (msg.type === 'register') {
        ws.send(JSON.stringify({
          type: 'registered', tunnelId: randomUUID(), ownerSecret: 'f'.repeat(64), publicUrl: 'tcp://example.test',
          protocol: msg.protocol, allocatedPort: 10022, localPort: msg.localPort,
        }));
        ws.send(JSON.stringify({ type: 'reboot' }));
      }
    });
  });
  return { wss, seen, url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

async function runCli({ server, config, env = {} }) {
  const dir = mkdtempSync(join(tmpRoot, 'run-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ server: server.url, ...config }), { mode: 0o600 });
  const child = spawn(process.execPath, [BIN, 'connect'], {
    env: {
      PATH: fakeBin, // only the fake reboot commands are resolvable
      HOME: dir,
      TUNNELVAULT_CONFIG: configPath,
      TUNNELVAULT_STATE_DIR: join(dir, 'state'),
      TUNNELVAULT_AUTH_TOKEN: 'cli-secret-token-42',
      TV_TEST_MARKER: marker,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, out, exited, dir };
}

test('fake reboot binaries are what the CLI would resolve', () => {
  execFileSync('systemctl', ['probe'], { env: { PATH: fakeBin, TV_TEST_MARKER: marker } });
  assert.match(readFileSync(marker, 'utf8'), /systemctl probe/);
  rmSync(marker);
});

test('connect: env token as Bearer header, config tunnels, reboot ignored by default, state 0600, clean SIGTERM', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const run = await runCli({ server, config: { tunnels: [{ port: 2222, protocol: 'tcp', name: 'ssh' }] } });
  t.after(() => run.child.kill('SIGKILL'));

  await waitFor(() => /Ignored remote reboot/.test(run.out.text), 'ignored-reboot log line');
  await waitFor(() => /public port 10022/.test(run.out.text), 'tunnel line');
  const up = server.seen.upgrades[0];
  assert.equal(up.headers.authorization, 'Bearer cli-secret-token-42');
  assert.equal(up.headers['x-tunnelvault-protocol'], '2');
  assert.equal(up.url, '/ws');
  assert.deepEqual(server.seen.messages.filter((m) => m.type === 'register').map((m) => m.localPort), [2222]);
  assert.ok(!existsSync(marker), 'no reboot command executed');
  assert.doesNotMatch(run.out.text, /cli-secret-token-42/, 'token never printed');
  assert.doesNotMatch(run.out.text, /EC2/);

  const stateFile = join(run.dir, 'state', 'state.json');
  await waitFor(() => existsSync(stateFile), 'state file');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(run.dir, 'state')).mode & 0o777, 0o700);

  run.child.kill('SIGTERM');
  const { code } = await run.exited;
  assert.equal(code, 0);
});

test('connect: "allow_reboot": true in config.json enables remote reboot; TUNNELVAULT_ALLOW_REBOOT=0 overrides it', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const denied = await runCli({
    server,
    config: { tunnels: [{ port: 2222, protocol: 'tcp' }], allow_reboot: true },
    env: { TUNNELVAULT_ALLOW_REBOOT: '0' },
  });
  t.after(() => denied.child.kill('SIGKILL'));
  await waitFor(() => /Ignored remote reboot/.test(denied.out.text), 'ignored-reboot log line');
  denied.child.kill('SIGTERM');
  await denied.exited;
  assert.ok(!existsSync(marker), 'env override disables reboot');

  const allowed = await runCli({ server, config: { tunnels: [{ port: 2222, protocol: 'tcp' }], allow_reboot: true } });
  t.after(() => allowed.child.kill('SIGKILL'));
  // `echo ... >> marker` creates the file before it writes the line: wait for the complete line.
  await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').endsWith('\n'), 'fake reboot command');
  const calls = readFileSync(marker, 'utf8').trim().split('\n');
  const expected = process.getuid && process.getuid() === 0 ? 'systemctl reboot' : 'sudo -n systemctl reboot';
  assert.deepEqual(calls, [expected]);
  allowed.child.kill('SIGTERM');
  await allowed.exited;
});

test('connect: invalid configuration exits non-zero with a clear message (no stack trace, no token)', async () => {
  const server = { url: 'ws://127.0.0.1:9' };
  const run = await runCli({ server, config: { tunnels: [{ port: 70000, protocol: 'tcp' }] } });
  const { code } = await run.exited;
  assert.equal(code, 1);
  assert.match(run.out.text, /Invalid tunnel port/);
  assert.doesNotMatch(run.out.text, /at .*tunnel\.js/);
  assert.doesNotMatch(run.out.text, /cli-secret-token-42/);
});
