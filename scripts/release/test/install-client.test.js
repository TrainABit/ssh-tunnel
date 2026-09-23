'use strict';
// Tests for install-client.sh:
//  * pure helpers (argument validation incl. --extra-port injection attempts, URL checks)
//    by sourcing the script with TV_INSTALL_CLIENT_SOURCE_ONLY=1
//  * the node JSON helpers (legacy config parsing, config generation)
//  * end-to-end installs/upgrades into a throwaway TUNNELVAULT_INSTALL_ROOT with stubbed
//    systemctl / systemd-run / npm (root only; nothing outside the temp dir is modified)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, mkTmp, run, makeKey } = require('./helpers');

const INSTALLER = path.join(REPO_ROOT, 'install-client.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** Runs `snippet` in bash after sourcing install-client.sh (main is not executed). */
function sh(snippet, args = [], env = {}) {
  return run('bash', ['-c', `source "$0" && ${snippet}`, INSTALLER, ...args], {
    env: { TV_INSTALL_CLIENT_SOURCE_ONLY: '1', ...env },
  });
}
const ok = (fn, value) => sh(`${fn} "$1"`, [value]).status === 0;

test('port / protocol / token / name / user validation', () => {
  for (const p of ['1', '22', '8080', '65535']) assert.ok(ok('valid_port', p), p);
  for (const p of ['0', '65536', '99999', '-1', '22a', '', ' 22', '022', '1e3', '22;id', '$(id)']) assert.ok(!ok('valid_port', p), p);
  for (const p of ['tcp', 'http']) assert.ok(ok('valid_protocol', p));
  for (const p of ['udp', 'TCP', 'https', '', 'tcp ']) assert.ok(!ok('valid_protocol', p), p);
  assert.ok(ok('valid_token', 'abcDEF0123'));
  assert.ok(ok('valid_token', 'a'.repeat(64)));
  for (const t of ['', 'a'.repeat(65), 'abc def', 'abc"', "abc'", 'abc$x', 'abc\n', 'tok-en', 'tok_en', 'ä']) {
    assert.ok(!ok('valid_token', t), JSON.stringify(t));
  }
  for (const u of ['pi', 'ubuntu', '_svc', 'user.name', 'a-b']) assert.ok(ok('valid_username', u), u);
  for (const u of ['', 'root user', '-x', 'a'.repeat(33), 'x;id', 'ALL:ALL', 'a,b', '9lives']) assert.ok(!ok('valid_username', u), u);
  for (const s of ['12h', '30min', '1d']) assert.ok(ok('valid_schedule', s), s);
  for (const s of ['', '0h', '12', '12h;x', 'h']) assert.ok(!ok('valid_schedule', s), s);
});

test('server URL validation', () => {
  for (const u of [
    'wss://tunnel.example.com', 'wss://tunnel.example.com/', 'wss://tunnel.example.com:443/ws',
    'ws://1.2.3.4:4000', 'ws://localhost:4000', 'ws://[::1]:4000', 'wss://[2001:db8::1]/tv/ws', 'ws://a',
  ]) assert.ok(ok('valid_server_url', u), u);
  for (const u of [
    '', 'http://example.com', 'https://example.com', 'ftp://x', 'ws://', 'ws:///x', 'ws://ex ample.com',
    'ws://user:pw@example.com', 'ws://example.com?auth_token=abc', 'ws://example.com/#x', 'ws://example.com:0',
    'ws://example.com:65536', 'ws://example.com/$(id)', 'ws://example.com/`id`', 'ws://example.com/a b',
    'ws://example.com/"x', "ws://example.com/'x", 'ws://example.com\nExecStart=/bin/sh', 'ws://-bad.com',
    'wss://example.com/%0aX', `wss://${'a'.repeat(250)}.com`,
  ]) assert.ok(!ok('valid_server_url', u), JSON.stringify(u));
});

test('plaintext-to-public-host detection', () => {
  const insecure = (u) => sh('is_insecure_remote_url "$1"', [u]).status === 0;
  for (const u of ['ws://1.2.3.4:4000', 'ws://tunnel.example.com', 'ws://[2001:db8::1]:4000', 'ws://172.32.0.1', 'ws://[fc::1]'])
    assert.ok(insecure(u), u);
  for (const u of [
    'wss://tunnel.example.com', 'ws://localhost:4000', 'ws://127.0.0.1:4000', 'ws://10.1.2.3', 'ws://172.16.0.9',
    'ws://192.168.1.10:4000', 'ws://169.254.1.1', 'ws://pi.local', 'ws://box.lan', 'ws://[::1]:4000',
    'ws://[fd12:3456::1]', 'ws://[fe80::1]', 'ws://[::ffff:10.0.0.1]',
  ]) assert.ok(!insecure(u), u);
});

test('--extra-port parsing rejects injection attempts', () => {
  const parse = (s) => sh('parse_extra_port "$1"', [s]);
  assert.equal(parse('8080:http:web').stdout, '8080 http web\n');
  assert.equal(parse('8080:tcp:my-app_1.x').stdout, '8080 tcp my-app_1.x\n');
  assert.equal(parse('8080').stdout, '8080 tcp tunnel-8080\n');
  assert.equal(parse('8080:HTTP').stdout, '8080 http tunnel-8080\n');
  assert.equal(parse('8080::db').stdout, '8080 tcp db\n');
  for (const bad of [
    '', ':tcp:x', '0:tcp:x', '65536:tcp:x', 'abc:tcp:x', '8080:udp:x', '8080:tcp:a:b', '8080:tcp:a b',
    '8080:tcp:a"', '8080:tcp:x", "port": 22, "y": "', '8080:tcp:$(id)', '8080:tcp:`id`', '8080:tcp:a;id',
    '8080:tcp:a\nb', '8080:tcp:a\\nb', '8080:tcp:../../etc', '8080:tcp:' + 'n'.repeat(65), '8080:tcp:ä',
    '80 80:tcp:x', '8080:tcp:x\r',
  ]) {
    const r = parse(bad);
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(bad)}: ${r.stdout}`);
    assert.equal(r.stdout, '');
  }
});

test('argument parsing: unknown / missing / conflicting options and injection attempts fail early', () => {
  const v = (...args) => sh('parse_args "$@" && validate_args && printf "%s" "$TUNNEL_SPECS"', args);
  let r = v('--server', 'wss://t.example.com', '--token', 'abc', '--port', '2222', '--extra-port', '8080:http:web',
    '--extra-port', '5432:tcp:db');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout, '2222 tcp tunnel-2222\n8080 http web\n5432 tcp db');
  r = v('--server', 'wss://t.example.com', '--token', 'abc');
  assert.equal(r.stdout, '22 tcp ssh');

  for (const args of [
    ['--bogus'], ['--server'], ['--token', ''], ['--server', 'http://x'], ['--token', 'a b'],
    ['--extra-port', '8080:tcp:x", "auth_token": "y'], ['--extra-port', '22:tcp:dup'], ['--port', '8080', '--extra-port', '8080'],
    ['--allow-reboot', '--no-reboot'], ['--auto-update', '--no-auto-update'], ['--protocol', 'udp'],
    ['--upgrade', '--protocol', 'http'], ['--user', 'root;id'], ['--release-pubkey', '/nonexistent/key.pub'],
  ]) {
    r = v(...args);
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(args)}`);
  }
  // --upgrade without tunnel flags keeps the existing tunnels (no specs built).
  r = v('--upgrade');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout, '');
});

test('--token-file reads the token without exposing it in argv', (t) => {
  const tmp = mkTmp(t);
  const f = path.join(tmp, 'tok');
  fs.writeFileSync(f, 'fileToken42\n');
  let r = sh('parse_args "$@" && validate_args && printf "%s" "$OPT_TOKEN"', ['--token-file', f]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout, 'fileToken42');
  fs.writeFileSync(f, 'bad token\n');
  r = sh('parse_args "$@" && validate_args', ['--token-file', f]);
  assert.notEqual(r.status, 0);
});

function readExisting(env) {
  const r = sh('node -e "$NODE_READ_EXISTING"', [], env);
  assert.equal(r.status, 0, r.out);
  const out = {};
  const warns = [];
  for (const line of r.stdout.trim().split('\n')) {
    const i = line.indexOf('=');
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    if (k === 'WARN') warns.push(v);
    else out[k] = v;
  }
  out.warns = warns;
  return out;
}

test('legacy config parsing (python3-free upgrade path)', (t) => {
  const tmp = mkTmp(t);
  const sys = path.join(tmp, 'config.json');
  const usr = path.join(tmp, 'user-config.json');
  const envf = path.join(tmp, 'client.env');
  const unit = path.join(tmp, 'unit');
  const none = path.join(tmp, 'missing');

  // 1. Legacy /etc config with auth_token and tunnels; http:// URL is mapped to ws://.
  fs.writeFileSync(sys, JSON.stringify({
    server: 'http://1.2.3.4:4000', auth_token: 'legacyTok1',
    tunnels: [{ port: 22, protocol: 'tcp', name: 'ssh' }, { port: 8080, protocol: 'http', name: 'web', subdomain: 'demo' }],
    custom_key: 'kept',
  }));
  let r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.SERVER, 'ws://1.2.3.4:4000');
  assert.equal(r.TOKEN, 'legacyTok1');
  assert.deepEqual(JSON.parse(r.TUNNELS_JSON), [
    { port: 22, protocol: 'tcp', name: 'ssh' }, { port: 8080, protocol: 'http', name: 'web', subdomain: 'demo' },
  ]);
  assert.equal(r.ALLOW_REBOOT, 'false');
  assert.deepEqual(JSON.parse(r.BASE_JSON), { custom_key: 'kept' });

  // 2. client.env wins over config.json; allow_reboot only from the root-owned config.
  fs.writeFileSync(envf, '# c\nTUNNELVAULT_SERVER="wss://t.example.com"\nTUNNELVAULT_AUTH_TOKEN=envTok9\n');
  fs.writeFileSync(sys, JSON.stringify({ server: 'wss://old.example.com', tunnels: [{ port: 22 }], allow_reboot: true }));
  fs.writeFileSync(usr, JSON.stringify({ server: 'ws://evil', auth_token: 'userTok', allow_reboot: true, tunnels: [{ port: 1 }] }));
  r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: usr, TV_CLIENT_ENV: envf, TV_UNIT_FILE: none });
  assert.equal(r.SERVER, 'wss://t.example.com');
  assert.equal(r.TOKEN, 'envTok9');
  assert.equal(r.ALLOW_REBOOT, 'true');
  assert.deepEqual(JSON.parse(r.TUNNELS_JSON), [{ port: 22, protocol: 'tcp', name: 'tunnel-22' }]);

  // 3. Only the service user's legacy copy: token/server/tunnels usable, allow_reboot NOT trusted.
  r = readExisting({ TV_SYS_CONFIG: none, TV_USER_CONFIG: usr, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.TOKEN, 'userTok');
  assert.equal(r.ALLOW_REBOOT, 'false');

  // 4. Broken python3-era upgrade: empty values -> fall back to the old unit's ExecStart.
  fs.writeFileSync(sys, JSON.stringify({ server: '', auth_token: '', tunnels: [{ port: 22, protocol: 'tcp', name: 'ssh' }] }));
  fs.writeFileSync(unit, '[Service]\nUser=pi\nExecStart=/usr/local/bin/tunnelvault connect --server ws://5.6.7.8:4000 --auth-token unitTok7\n');
  r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: unit });
  assert.equal(r.SERVER, 'ws://5.6.7.8:4000');
  assert.equal(r.TOKEN, 'unitTok7');
  assert.equal(r.UNIT_USER, 'pi');

  // 5. Token in a legacy ?auth_token= query string is recovered, the query is dropped.
  fs.writeFileSync(sys, JSON.stringify({ server: 'ws://h.example.com:4000/?auth_token=qTok5', tunnels: [{ port: 22 }] }));
  r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.SERVER, 'ws://h.example.com:4000');
  assert.equal(r.TOKEN, 'qTok5');
  assert.ok(r.warns.some((w) => /query string/.test(w)));

  // 6. Invalid / hostile values are dropped, invalid tunnels flagged, garbage JSON ignored.
  fs.writeFileSync(sys, JSON.stringify({ server: 'ws://x.example.com', auth_token: 'bad"token$(id)', tunnels: [{ port: 99999 }] }));
  r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.TOKEN, '');
  assert.equal(r.TUNNELS_INVALID, '1');
  fs.writeFileSync(sys, '{not json');
  r = readExisting({ TV_SYS_CONFIG: sys, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.SERVER, '');
  assert.equal(r.TOKEN, '');
  assert.ok(r.warns.some((w) => /invalid JSON/.test(w)));
  // Nothing at all -> empty values (the installer then refuses to write an empty server/token).
  r = readExisting({ TV_SYS_CONFIG: none, TV_USER_CONFIG: none, TV_CLIENT_ENV: none, TV_UNIT_FILE: none });
  assert.equal(r.SERVER, '');
  assert.equal(r.TOKEN, '');
});

test('config.json generation with node (no token, validated, injection-proof)', () => {
  const build = (env) => sh('node -e "$NODE_BUILD_CONFIG"', [], env);
  let r = build({
    TV_SERVER: 'wss://t.example.com', TV_ALLOW_REBOOT: 'true', TV_TUNNEL_SPECS: '22 tcp ssh\n8080 http web',
    TV_BASE_JSON: '{"auth_token":"leak","x":1}',
  });
  assert.equal(r.status, 0, r.out);
  const cfg = JSON.parse(r.stdout);
  assert.deepEqual(cfg, {
    server: 'wss://t.example.com',
    tunnels: [{ port: 22, protocol: 'tcp', name: 'ssh' }, { port: 8080, protocol: 'http', name: 'web' }],
    allow_reboot: true,
    x: 1,
  });
  assert.ok(!('auth_token' in cfg));

  r = build({ TV_SERVER: 'ws://1.2.3.4:4000', TV_ALLOW_REBOOT: 'false', TV_TUNNELS_JSON: '[{"port":22,"protocol":"tcp","name":"ssh","subdomain":"s"}]' });
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).allow_reboot, false);
  assert.equal(JSON.parse(r.stdout).tunnels[0].subdomain, 's');

  for (const env of [
    { TV_SERVER: '', TV_TUNNEL_SPECS: '22 tcp ssh' },
    { TV_SERVER: 'ws://x"y', TV_TUNNEL_SPECS: '22 tcp ssh' },
    { TV_SERVER: 'ws://x', TV_TUNNEL_SPECS: '' },
    { TV_SERVER: 'ws://x', TV_TUNNEL_SPECS: '22 udp ssh' },
    { TV_SERVER: 'ws://x', TV_TUNNEL_SPECS: '22 tcp ssh\n22 tcp dup' },
    { TV_SERVER: 'ws://x', TV_TUNNELS_JSON: '{"port":22}' },
  ]) assert.notEqual(build(env).status, 0, JSON.stringify(env));
});

test('generated systemd unit, env file and sudoers rule', (t) => {
  const vars = 'SERVICE_USER=pi SERVICE_GROUP=pi USER_HOME=/home/pi SERVER_URL=wss://t.example.com AUTH_TOKEN=tok123';
  let r = sh(`${vars.replace(/ /g, '; ')}; ALLOW_REBOOT=false; render_service_unit`);
  assert.equal(r.status, 0, r.out);
  let unit = r.stdout;
  assert.match(unit, /^EnvironmentFile=\/etc\/tunnelvault\/client\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/tunnelvault connect$/m);
  assert.match(unit, /^User=pi$/m);
  assert.doesNotMatch(unit, /tok123|--auth-token|--server/);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=-\/home\/pi\/\.tunnelvault$/m);
  assert.doesNotMatch(unit, /MemoryDenyWriteExecute/); // would break V8's JIT

  r = sh(`${vars.replace(/ /g, '; ')}; ALLOW_REBOOT=true; render_service_unit`);
  unit = r.stdout;
  assert.doesNotMatch(unit, /^(NoNewPrivileges|CapabilityBoundingSet|RestrictSUIDSGID|PrivateDevices)=/m); // sudo must work
  assert.match(unit, /^ProtectSystem=full$/m);

  r = sh(`${vars.replace(/ /g, '; ')}; render_client_env`);
  assert.match(r.stdout, /^TUNNELVAULT_SERVER=wss:\/\/t\.example\.com$/m);
  assert.match(r.stdout, /^TUNNELVAULT_AUTH_TOKEN=tok123$/m);

  r = sh('SERVICE_USER=pi; render_sudoers');
  assert.match(r.stdout, /^pi ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl reboot, \/bin\/systemctl reboot, \/usr\/sbin\/reboot "", \/sbin\/reboot ""$/m);
  const visudo = run('bash', ['-c', 'command -v visudo']);
  if (visudo.status === 0) {
    const tmp = mkTmp(t);
    fs.writeFileSync(path.join(tmp, 'rule'), r.stdout, { mode: 0o440 });
    const c = run(visudo.stdout.trim(), ['-c', '-q', '-f', path.join(tmp, 'rule')]);
    assert.equal(c.status, 0, c.out);
  }

  r = sh('UPDATE_SCHEDULE=12h; render_updater_timer; UPDATE_ENABLED=1; UPDATE_REPO=TrainABit/ssh-tunnel; PINNED_VERSION=; render_update_conf; render_updater_service');
  assert.match(r.stdout, /^OnUnitActiveSec=12h$/m);
  assert.match(r.stdout, /^ENABLED=1$/m);
  assert.match(r.stdout, /^PUBKEY=\/etc\/tunnelvault\/release-signing\.pub$/m);
  assert.match(r.stdout, /^ExecStart=\/opt\/tunnelvault-client\/auto-update-client\.sh$/m);
});

// ── End-to-end (root only) ───────────────────────────────────────────────────

function makeStubs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  write('systemctl', `echo "systemctl $*" >> "$STUB_LOG"
if [[ $1 == is-active ]]; then
  if [[ \${STUB_ACTIVE:-0} == 1 ]]; then [[ $2 == --quiet ]] || echo active; exit 0; fi
  [[ $2 == --quiet ]] || echo inactive; exit 3
fi
exit 0`);
  write('systemd-run', 'echo "systemd-run $*" >> "$STUB_LOG"; exit 0');
  write('npm', `echo "npm $*" >> "$STUB_LOG"
[[ \${STUB_NPM_FAIL:-0} == 1 ]] && exit 1
mkdir -p node_modules/.stub && echo ok > node_modules/.stub/installed; exit 0`);
  write('apt-get', 'echo "apt-get must not run in tests" >&2; exit 99');
  return dir;
}

/** Throwaway install root under /tmp (world-traversable so `runuser -u nobody` works). */
function e2eRoot(t) {
  const root = fs.mkdtempSync('/tmp/tv-install-client-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  for (const d of ['etc/systemd/system', 'etc/sudoers.d', 'run', 'usr/local/bin', 'opt', 'root', 'nonexistent', 'home']) {
    fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o755 });
  }
  fs.chmodSync(path.join(root, 'root'), 0o700);
  const stubs = makeStubs(path.join(root, '.stubs'));
  const log = path.join(root, '.stub.log');
  fs.writeFileSync(log, '');
  const install = (args, env = {}) => run('bash', [INSTALLER, ...args], {
    env: {
      TUNNELVAULT_INSTALL_ROOT: root,
      PATH: `${stubs}:${process.env.PATH}`,
      STUB_LOG: log,
      SUDO_USER: '',
      USER: 'root',
      ...env,
    },
  });
  const p = (rel) => path.join(root, rel);
  const mode = (rel) => fs.statSync(p(rel)).mode & 0o777;
  const stubLog = () => fs.readFileSync(log, 'utf8');
  return { root, p, mode, install, stubLog, log };
}

function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(f));
    else if (e.isFile()) out.push(f);
  }
  return out;
}

test('e2e: fresh install for an unprivileged user with reboot + auto-update', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  const keys = makeKey(path.join(mkTmp(t), 'k'));
  const r = e.install([
    '--server', 'wss://tunnel.example.com', '--token', 'SecretTok123', '--user', 'nobody',
    '--extra-port', '8080:http:web', '--allow-reboot', '--auto-update', '--release-pubkey', keys.pub,
  ]);
  assert.equal(r.status, 0, r.out);

  // Token only in client.env (0600 root).
  const env = fs.readFileSync(e.p('etc/tunnelvault/client.env'), 'utf8');
  assert.match(env, /^TUNNELVAULT_SERVER=wss:\/\/tunnel\.example\.com$/m);
  assert.match(env, /^TUNNELVAULT_AUTH_TOKEN=SecretTok123$/m);
  assert.equal(e.mode('etc/tunnelvault/client.env'), 0o600);
  assert.equal(fs.statSync(e.p('etc/tunnelvault/client.env')).uid, 0);
  const withToken = allFiles(e.root).filter((f) => !f.includes('/.stub') && !f.includes('/opt/')
    && fs.readFileSync(f, 'utf8').includes('SecretTok123'));
  assert.deepEqual(withToken, [e.p('etc/tunnelvault/client.env')]);
  assert.doesNotMatch(e.stubLog(), /SecretTok123/);

  // config.json copies: no token, 0600; user copy owned by the service user in a 0700 dir.
  const sys = JSON.parse(fs.readFileSync(e.p('etc/tunnelvault/config.json'), 'utf8'));
  assert.deepEqual(sys, {
    server: 'wss://tunnel.example.com',
    tunnels: [{ port: 22, protocol: 'tcp', name: 'ssh' }, { port: 8080, protocol: 'http', name: 'web' }],
    allow_reboot: true,
  });
  assert.equal(e.mode('etc/tunnelvault/config.json'), 0o600);
  const userCfg = e.p('nonexistent/.tunnelvault/config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(userCfg, 'utf8')), sys);
  assert.equal(e.mode('nonexistent/.tunnelvault/config.json'), 0o600);
  assert.equal(e.mode('nonexistent/.tunnelvault'), 0o700);
  assert.equal(fs.statSync(userCfg).uid, 65534);
  assert.equal(fs.statSync(e.p('nonexistent/.tunnelvault')).uid, 65534);

  // Service unit.
  const unit = fs.readFileSync(e.p('etc/systemd/system/tunnelvault-client.service'), 'utf8');
  assert.match(unit, /^User=nobody$/m);
  assert.match(unit, /^Group=nogroup$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/tunnelvault connect$/m);
  assert.doesNotMatch(unit, /^NoNewPrivileges=/m);

  // Sudoers rule (validated) for the service user.
  const sudoers = fs.readFileSync(e.p('etc/sudoers.d/tunnelvault-reboot'), 'utf8');
  assert.match(sudoers, /^nobody ALL=\(root\) NOPASSWD: /m);
  assert.equal(e.mode('etc/sudoers.d/tunnelvault-reboot'), 0o440);
  assert.deepEqual(fs.readdirSync(e.p('etc/sudoers.d')), ['tunnelvault-reboot']);

  // Code, VERSION, CLI wrapper, updater.
  assert.equal(fs.readFileSync(e.p('opt/tunnelvault-client/VERSION'), 'utf8'),
    `${fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8').trim()}\n`);
  assert.ok(fs.existsSync(e.p('opt/tunnelvault-client/bin/tunnelvault.js')));
  assert.ok(fs.existsSync(e.p('opt/tunnelvault-client/node_modules/.stub/installed')), 'npm ci ran in the staged dir');
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client/test')), 'tests are not installed');
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client.new')));
  assert.match(e.stubLog(), /^npm ci --omit=dev --ignore-scripts/m);
  assert.match(fs.readFileSync(e.p('usr/local/bin/tunnelvault'), 'utf8'), /^exec \S+ \/opt\/tunnelvault-client\/bin\/tunnelvault\.js "\$@"$/m);
  assert.equal(fs.readFileSync(e.p('opt/tunnelvault-client/auto-update-client.sh'), 'utf8'),
    fs.readFileSync(path.join(REPO_ROOT, 'auto-update-client.sh'), 'utf8'));
  assert.equal(fs.readFileSync(e.p('etc/tunnelvault/release-signing.pub'), 'utf8'), fs.readFileSync(keys.pub, 'utf8'));
  const conf = fs.readFileSync(e.p('etc/tunnelvault/update.conf'), 'utf8');
  assert.match(conf, /^ENABLED=1$/m);
  assert.match(conf, /^UPDATE_REPO=TrainABit\/ssh-tunnel$/m);
  assert.ok(fs.existsSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.timer')));
  assert.match(e.stubLog(), /^systemctl enable --now tunnelvault-client-autoupdate\.timer$/m);
  assert.match(e.stubLog(), /^systemctl restart tunnelvault-client$/m);
  assert.doesNotMatch(r.stdout, /git pull/);
  assert.doesNotMatch(r.stdout, /WARNING:.*plaintext/);
});

test('e2e: upgrade from a legacy (git-updater, token-in-argv) install', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  // Legacy layout written by the old installer.
  fs.mkdirSync(e.p('etc/tunnelvault'), { recursive: true });
  fs.writeFileSync(e.p('etc/tunnelvault/config.json'), JSON.stringify({
    server: 'ws://203.0.113.5:4000', auth_token: 'LegacyTok99',
    tunnels: [{ port: 22, protocol: 'tcp', name: 'ssh' }, { port: 3000, protocol: 'http', name: 'app' }],
  }, null, 2));
  fs.mkdirSync(e.p('nonexistent/.tunnelvault'), { recursive: true });
  fs.writeFileSync(e.p('nonexistent/.tunnelvault/config.json'), '{"auth_token":"LegacyTok99"}');
  fs.writeFileSync(e.p('nonexistent/.tunnelvault/state.json'), '{"tunnels":{}}', { mode: 0o644 });
  fs.chownSync(e.p('nonexistent/.tunnelvault'), 65534, 65534);
  fs.chownSync(e.p('nonexistent/.tunnelvault/config.json'), 65534, 65534);
  fs.chownSync(e.p('nonexistent/.tunnelvault/state.json'), 65534, 65534);
  fs.writeFileSync(e.p('etc/systemd/system/tunnelvault-client.service'),
    '[Service]\nUser=nobody\nExecStart=/usr/local/bin/tunnelvault connect --server ws://203.0.113.5:4000 --auth-token LegacyTok99\n');
  fs.writeFileSync(e.p('etc/sudoers.d/tunnelvault-reboot'), 'nobody ALL=(ALL) NOPASSWD: /bin/systemctl reboot, /sbin/reboot\n');
  fs.writeFileSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.service'), '[Service]\nExecStart=/opt/tunnelvault-client/auto-update-client.sh\n');
  fs.writeFileSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.timer'), '[Timer]\nOnUnitActiveSec=12h\n');
  fs.mkdirSync(e.p('opt/tunnelvault-client/node_modules'), { recursive: true });
  fs.writeFileSync(e.p('opt/tunnelvault-client/package.json'), '{"name":"old"}');
  fs.writeFileSync(e.p('opt/tunnelvault-client/auto-update-client.sh'), '#!/bin/bash\ngit pull origin main\n');

  const r = e.install(['--upgrade'], { STUB_ACTIVE: '1' });
  assert.equal(r.status, 0, r.out);

  const env = fs.readFileSync(e.p('etc/tunnelvault/client.env'), 'utf8');
  assert.match(env, /^TUNNELVAULT_SERVER=ws:\/\/203\.0\.113\.5:4000$/m);
  assert.match(env, /^TUNNELVAULT_AUTH_TOKEN=LegacyTok99$/m);
  for (const f of ['etc/tunnelvault/config.json', 'nonexistent/.tunnelvault/config.json']) {
    const cfg = JSON.parse(fs.readFileSync(e.p(f), 'utf8'));
    assert.ok(!('auth_token' in cfg), `${f} still has the token`);
    assert.equal(cfg.allow_reboot, false);
    assert.deepEqual(cfg.tunnels.map((x) => x.port), [22, 3000]);
  }
  assert.equal(e.mode('nonexistent/.tunnelvault/state.json'), 0o600, 'legacy 0644 state.json tightened');
  const unit = fs.readFileSync(e.p('etc/systemd/system/tunnelvault-client.service'), 'utf8');
  assert.match(unit, /^User=nobody$/m, 'service user preserved');
  assert.doesNotMatch(unit, /LegacyTok99/);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.ok(!fs.existsSync(e.p('etc/sudoers.d/tunnelvault-reboot')), 'unconditional legacy reboot rule removed');
  assert.ok(!fs.existsSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.timer')), 'git updater removed');
  assert.ok(!fs.existsSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.service')));
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client/auto-update-client.sh')));
  assert.match(r.stdout, /Removed the old git-based auto-updater/);
  assert.ok(fs.existsSync(e.p('opt/tunnelvault-client.previous/package.json')), 'previous version kept for rollback');
  // Live tunnel: restart delayed through systemd-run, not an immediate restart.
  assert.match(e.stubLog(), /^systemd-run .*--on-active=30s .*restart tunnelvault-client\.service$/m);
  assert.doesNotMatch(e.stubLog(), /^systemctl restart tunnelvault-client$/m);
  // Plaintext to a public IP -> prominent warning; no git instructions.
  assert.match(r.stdout, /WARNING:.*plaintext/);
  assert.doesNotMatch(r.stdout, /git pull/);
});

test('e2e: upgrade keeps reboot/auto-update choices and update.conf settings', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  const keys = makeKey(path.join(mkTmp(t), 'k'));
  let r = e.install(['--server', 'ws://192.168.1.2:4000', '--token', 'Tok1', '--allow-reboot', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  // service user root -> no sudoers file needed
  assert.ok(!fs.existsSync(e.p('etc/sudoers.d/tunnelvault-reboot')));
  const confFile = e.p('etc/tunnelvault/update.conf');
  fs.writeFileSync(confFile, fs.readFileSync(confFile, 'utf8').replace('PINNED_VERSION=', 'PINNED_VERSION=2.0.0').replace('ENABLED=1', 'ENABLED=0'));

  r = e.install(['--upgrade', '--token', 'Tok2']);
  assert.equal(r.status, 0, r.out);
  const cfg = JSON.parse(fs.readFileSync(e.p('etc/tunnelvault/config.json'), 'utf8'));
  assert.equal(cfg.allow_reboot, true);
  assert.equal(cfg.server, 'ws://192.168.1.2:4000');
  assert.match(fs.readFileSync(e.p('etc/tunnelvault/client.env'), 'utf8'), /^TUNNELVAULT_AUTH_TOKEN=Tok2$/m);
  const conf = fs.readFileSync(confFile, 'utf8');
  assert.match(conf, /^PINNED_VERSION=2\.0\.0$/m);
  assert.match(conf, /^ENABLED=0$/m);
  assert.ok(fs.existsSync(e.p('opt/tunnelvault-client/auto-update-client.sh')), 'updater kept on upgrade');
  assert.ok(fs.existsSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.timer')));
  assert.doesNotMatch(r.stdout, /WARNING:.*plaintext/, 'private LAN address is not warned about');

  // --no-reboot / --no-auto-update / new tunnels replace the old choices.
  r = e.install(['--upgrade', '--no-reboot', '--no-auto-update', '--port', '2222']);
  assert.equal(r.status, 0, r.out);
  const cfg2 = JSON.parse(fs.readFileSync(e.p('etc/tunnelvault/config.json'), 'utf8'));
  assert.equal(cfg2.allow_reboot, false);
  assert.deepEqual(cfg2.tunnels, [{ port: 2222, protocol: 'tcp', name: 'tunnel-2222' }]);
  assert.ok(!fs.existsSync(e.p('etc/systemd/system/tunnelvault-client-autoupdate.timer')));
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client/auto-update-client.sh')));
  assert.match(fs.readFileSync(e.p('etc/systemd/system/tunnelvault-client.service'), 'utf8'), /^NoNewPrivileges=yes$/m);
  assert.match(e.stubLog(), /^npm ci/m);
  assert.equal((e.stubLog().match(/^npm ci/gm) || []).length, 1, 'unchanged dependencies are reused, not reinstalled');
});

test('e2e: upgrade refuses to write an empty server/token', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  fs.mkdirSync(e.p('etc/tunnelvault'), { recursive: true });
  fs.writeFileSync(e.p('etc/tunnelvault/config.json'), JSON.stringify({ server: '', auth_token: '', tunnels: [{ port: 22 }] }));
  fs.mkdirSync(e.p('opt/tunnelvault-client'), { recursive: true });
  const r = e.install(['--upgrade']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Could not read the server URL/);
  assert.ok(!fs.existsSync(e.p('etc/tunnelvault/client.env')));
  assert.equal(JSON.parse(fs.readFileSync(e.p('etc/tunnelvault/config.json'), 'utf8')).server, '', 'config untouched');
});

test('e2e: npm failure leaves the installed client untouched', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  let r = e.install(['--server', 'wss://t.example.com', '--token', 'Tok1']);
  assert.equal(r.status, 0, r.out);
  const before = fs.readFileSync(e.p('opt/tunnelvault-client/package.json'), 'utf8');
  fs.writeFileSync(e.p('opt/tunnelvault-client/package-lock.json'), '{"changed":true}'); // force npm ci
  r = e.install(['--upgrade'], { STUB_NPM_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /npm ci failed — the installed client was not changed/);
  assert.equal(fs.readFileSync(e.p('opt/tunnelvault-client/package.json'), 'utf8'), before);
  assert.ok(fs.existsSync(e.p('opt/tunnelvault-client/node_modules/.stub/installed')));
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client.new')));
});

test('e2e: invalid arguments fail before anything is written', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  for (const args of [
    ['--server', 'wss://t.example.com', '--token', 'Tok1', '--extra-port', '8080:tcp:x","auth_token":"y'],
    ['--server', 'wss://t.example.com', '--token', 'Tok1', '--extra-port', '8080:tcp:$(touch /tmp/tv-pwned)'],
    ['--server', 'wss://t.example.com\nExecStartPre=/bin/sh', '--token', 'Tok1'],
    ['--server', 'wss://t.example.com', '--token', 'Tok1\nExecStartPre=/bin/sh'],
    ['--server', 'wss://t.example.com'],
    ['--token', 'Tok1'],
    ['--server', 'wss://t.example.com', '--token', 'Tok1', '--user', 'no-such-user-tv'],
  ]) {
    const r = e.install(args);
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(args)}`);
  }
  assert.ok(!fs.existsSync('/tmp/tv-pwned'));
  assert.ok(!fs.existsSync(e.p('etc/tunnelvault/client.env')));
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client')));
  assert.ok(!fs.existsSync(e.p('etc/systemd/system/tunnelvault-client.service')));
});

test('e2e: uninstall-client.sh removes everything the installer created', { skip: !IS_ROOT && 'needs root' }, (t) => {
  const e = e2eRoot(t);
  const keys = makeKey(path.join(mkTmp(t), 'k'));
  let r = e.install(['--server', 'wss://t.example.com', '--token', 'Tok1', '--user', 'nobody', '--allow-reboot',
    '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  fs.writeFileSync(e.p('nonexistent/.tunnelvault/state.json'), '{}', { mode: 0o644 });
  r = e.install(['--upgrade']); // root-owned state.json: warning only; creates opt/tunnelvault-client.previous
  assert.equal(r.status, 0, r.out);
  assert.match(r.stderr, /could not chmod 600 .*state\.json/);
  fs.chownSync(e.p('nonexistent/.tunnelvault/state.json'), 65534, 65534);
  r = e.install(['--upgrade']);
  assert.equal(e.mode('nonexistent/.tunnelvault/state.json'), 0o600);
  assert.equal(r.status, 0, r.out);
  fs.mkdirSync(e.p('var/log'), { recursive: true });
  fs.writeFileSync(e.p('var/log/tunnelvault-client-update.log'), 'x\n');

  const uninstall = (args) => run('bash', [path.join(REPO_ROOT, 'uninstall-client.sh'), ...args], {
    env: { TUNNELVAULT_INSTALL_ROOT: e.root, PATH: `${path.join(e.root, '.stubs')}:${process.env.PATH}`, STUB_LOG: e.log, SUDO_USER: '' },
  });

  // --keep-config keeps token/config/state for a reinstall.
  r = uninstall(['--yes', '--keep-config']);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(e.p('etc/tunnelvault/client.env')));
  assert.ok(fs.existsSync(e.p('nonexistent/.tunnelvault/state.json')));
  assert.ok(!fs.existsSync(e.p('opt/tunnelvault-client')));

  // Unattended (updater) upgrade cannot guess the service user once the unit is gone.
  r = e.install(['--upgrade'], { TUNNELVAULT_UPDATER: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot determine the service user/);
  r = e.install(['--upgrade', '--user', 'nobody', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(e.p('etc/tunnelvault/client.env'), 'utf8'), /^TUNNELVAULT_AUTH_TOKEN=Tok1$/m, 'kept config reused');
  r = uninstall(['--yes']);
  assert.equal(r.status, 0, r.out);
  for (const rel of [
    'etc/systemd/system/tunnelvault-client.service', 'etc/systemd/system/tunnelvault-client-autoupdate.service',
    'etc/systemd/system/tunnelvault-client-autoupdate.timer', 'etc/sudoers.d/tunnelvault-reboot',
    'etc/tunnelvault', 'opt/tunnelvault-client', 'opt/tunnelvault-client.previous', 'usr/local/bin/tunnelvault',
    'nonexistent/.tunnelvault', 'var/log/tunnelvault-client-update.log', 'run/tunnelvault-client-install.lock',
  ]) assert.ok(!fs.existsSync(e.p(rel)), `${rel} still exists`);
  assert.match(e.stubLog(), /^systemctl disable --now tunnelvault-client-autoupdate\.timer$/m);
  assert.match(e.stubLog(), /^systemctl disable tunnelvault-client$/m);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'install-client.sh')), 'source tree is never removed with --yes alone');

  // Shared files stay when the server is installed on the same host.
  r = e.install(['--server', 'wss://t.example.com', '--token', 'Tok1', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  fs.mkdirSync(e.p('opt/tunnelvault'), { recursive: true });
  r = uninstall(['--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(e.p('etc/tunnelvault/update.conf')));
  assert.ok(fs.existsSync(e.p('etc/tunnelvault/release-signing.pub')));
  assert.ok(!fs.existsSync(e.p('etc/tunnelvault/client.env')));
});
