'use strict';

/**
 * Functional tests for the legacy SSH gateway scripts in gateway/:
 *   gateway-helper.sh  against a temp SQLite DB created by backend/src/database.js
 *   usermgr-worker.sh  with a stub manage-user.sh and a temp spool (incl. requests
 *                      written by the real backend userManager)
 *   manage-user.sh     with stubbed useradd/usermod/userdel/getent/... (no real users)
 *   ssh_router.sh      with stubbed sudo/helper/nc/logger
 *   register_token.sh  with a stubbed runuser + manage-user.sh against a temp DB
 *
 * Every script is run from a patched copy whose constants (INSTALL_DIR,
 * SERVICE_USER, PATH, root check) point into a temp directory, so nothing on
 * the host is modified. Needs the sqlite3 CLI (TV_TEST_SQLITE3 or PATH) for
 * the tests that use a database; those are skipped without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const Database = require('better-sqlite3');

const REPO = path.join(__dirname, '..', '..');
const GATEWAY = path.join(REPO, 'gateway');
const BACKEND = path.join(REPO, 'backend');
const ME = os.userInfo();
const NODE_DIR = path.dirname(process.execPath);
const SYS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function which(name, envVar) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  const r = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const SQLITE3 = which('sqlite3', 'TV_TEST_SQLITE3');
const SQLITE_DIR = SQLITE3 ? path.dirname(SQLITE3) : '';
const needSqlite = SQLITE3 ? {} : { skip: 'sqlite3 CLI not available (set TV_TEST_SQLITE3)' };

const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0YjmXlF6rN4lB5e0mQv4Yv2vYq8g0v5m3yJt0VQpA user@laptop';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-ops-gw-'));
  fs.chmodSync(dir, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copy a script, applying [regex, replacement] pairs (each must match). */
function patchScript(src, dest, pairs) {
  let s = fs.readFileSync(src, 'utf8');
  for (const [re, rep] of pairs) {
    assert.match(s, re, `patch target ${re} not found in ${path.basename(src)}`);
    s = s.replace(re, () => rep);
  }
  fs.writeFileSync(dest, s, { mode: 0o755 });
  return dest;
}

function writeExec(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

function pathLine(stubDir) {
  return `export PATH="${[stubDir, NODE_DIR, SQLITE_DIR, SYS_PATH].filter(Boolean).join(':')}"`;
}

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(BACKEND, 'src', 'database.js'))}).close()`],
    { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return new Database(dbPath);
}

function addToken(db, token, fields = {}) {
  const row = { label: '', target_ip: '10.0.0.5', target_port: 22, public_key: PUBKEY, linux_user: `gw-${token}`, active: 1, ...fields };
  db.prepare(`INSERT INTO tokens (token, label, target_ip, target_port, public_key, linux_user, active)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, row.label, row.target_ip, row.target_port, row.public_key, row.linux_user, row.active);
}

// ─────────────────────────────────────────────────────────────
// gateway-helper.sh
// ─────────────────────────────────────────────────────────────
function helperEnv(t) {
  const dir = tmpDir(t);
  const install = path.join(dir, 'opt');
  const dbPath = path.join(install, 'data', 'custom.db');
  fs.mkdirSync(path.join(install, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(install, 'backend', '.env'), `PORT=4000\nDB_PATH=/wrong/first.db\nDB_PATH=${dbPath}   # custom location\n`, { mode: 0o600 });
  const db = initDb(dbPath);
  t.after(() => db.close());
  const helper = patchScript(path.join(GATEWAY, 'gateway-helper.sh'), path.join(dir, 'gateway-helper.sh'), [
    [/^readonly INSTALL_DIR=.*$/m, `readonly INSTALL_DIR="${install}"`],
    [/^readonly SERVICE_USER=.*$/m, `readonly SERVICE_USER="${ME.username}"`],
    [/^export PATH=.*$/m, pathLine('')],
  ]);
  const run = (args, sudoUser = 'gw-tok1', extraEnv = {}) => {
    const env = { ...process.env, ...extraEnv };
    if (sudoUser === null) delete env.SUDO_USER; else env.SUDO_USER = sudoUser;
    return spawnSync('bash', [helper, ...args], { encoding: 'utf8', env });
  };
  return { dir, db, helper, run, dbPath };
}

test('gateway-helper: lookup returns only the caller\'s own token', needSqlite, (t) => {
  const { db, run } = helperEnv(t);
  addToken(db, 'tok1', { target_ip: '10.0.0.5', target_port: 2222 });
  addToken(db, 'tok2', { target_ip: '10.0.0.6', active: 0 });
  addToken(db, 'wsonly', { linux_user: 'ws-wsonly', public_key: '' });

  let r = run(['lookup']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '10.0.0.5|2222|1\n');

  r = run(['lookup'], 'gw-tok2');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '10.0.0.6|22|0\n', 'inactive tokens are reported with active=0');

  for (const who of [null, '', 'root', 'tunnelvault', 'gw-', "gw-tok1' OR '1'='1", 'gw-tok1;id', `gw-${'a'.repeat(30)}`, 'gw-unknown', 'gw-wsonly']) {
    r = run(['lookup'], who);
    assert.equal(r.status, 3, `SUDO_USER=${who} must be denied (${r.stderr})`);
    assert.equal(r.stdout, '');
  }
  assert.equal(run(['lookup', 'extra']).status, 2);
  assert.equal(run(['drop-table']).status, 2);
  assert.equal(run([]).status, 2);
});

test('gateway-helper: refuses to run as another user', needSqlite, (t) => {
  const { dir, dbPath } = helperEnv(t);
  const other = patchScript(path.join(dir, 'gateway-helper.sh'), path.join(dir, 'other.sh'), [
    [/^readonly SERVICE_USER=.*$/m, 'readonly SERVICE_USER="tunnelvault-not-me"'],
  ]);
  const r = spawnSync('bash', [other, 'lookup'], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'gw-tok1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must run as tunnelvault-not-me/);
  assert.ok(fs.existsSync(dbPath));
});

test('gateway-helper: session-start/-end record sessions for active tokens only', needSqlite, (t) => {
  const { db, run } = helperEnv(t);
  addToken(db, 'tok1', { target_ip: '10.0.0.5', target_port: 2222 });
  addToken(db, 'tok2', { active: 0 });
  addToken(db, 'tok3');

  let r = run(['session-start', '203.0.113.7', '4242']);
  assert.equal(r.status, 0, r.stderr);
  const id = Number(r.stdout.trim());
  assert.ok(id > 0);
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  assert.equal(s.token, 'tok1');
  assert.equal(s.client_ip, '203.0.113.7');
  assert.equal(s.pid, 4242);
  assert.equal(s.target_ip, '10.0.0.5');
  assert.equal(s.target_port, 2222);
  assert.equal(s.disconnected_at, null);
  assert.ok(db.prepare("SELECT last_seen FROM tokens WHERE token = 'tok1'").get().last_seen, 'last_seen updated');

  // IPv6 accepted; anything else stored as NULL (never interpolated)
  r = run(['session-start', '2001:db8::1', '4243']);
  assert.equal(db.prepare('SELECT client_ip FROM sessions WHERE id = ?').get(Number(r.stdout)).client_ip, '2001:db8::1');
  r = run(['session-start', "1.2.3.4'); DROP TABLE tokens; --", '4244']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare('SELECT client_ip FROM sessions WHERE id = ?').get(Number(r.stdout)).client_ip, null);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tokens'").get());

  for (const pid of ['0', '-1', 'abc', '1;DROP', '99999999999', '4194305', '']) {
    assert.equal(run(['session-start', '1.2.3.4', pid]).status, 2, `pid ${pid}`);
  }
  // inactive or unknown token: no row
  const before = db.prepare('SELECT count(*) AS n FROM sessions').get().n;
  assert.equal(run(['session-start', '1.2.3.4', '100'], 'gw-tok2').status, 3);
  assert.equal(run(['session-start', '1.2.3.4', '100'], 'gw-nope').status, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, before);

  // session-end: only the caller's own open session
  assert.equal(run(['session-end', String(id)], 'gw-tok3').status, 3, 'other token cannot close it');
  assert.equal(db.prepare('SELECT disconnected_at FROM sessions WHERE id = ?').get(id).disconnected_at, null);
  r = run(['session-end', String(id)]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(db.prepare('SELECT disconnected_at FROM sessions WHERE id = ?').get(id).disconnected_at);
  assert.equal(run(['session-end', String(id)]).status, 3, 'already closed');
  for (const bad of ['0', 'x', '1 OR 1=1', '1;', '1234567890123456']) {
    assert.equal(run(['session-end', bad]).status, 2, `id ${bad}`);
  }
});

test('gateway-helper: waits for a busy database (.timeout)', needSqlite, async (t) => {
  const { db, helper, dbPath } = helperEnv(t);
  addToken(db, 'tok1');
  const locker = new Database(dbPath);
  t.after(() => locker.close());
  locker.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  const child = spawn('bash', [helper, 'session-start', '192.0.2.1', '77'], { env: { ...process.env, SUDO_USER: 'gw-tok1' } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  setTimeout(() => locker.exec('COMMIT'), 800);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  assert.match(out, /^\d+\n$/);
  assert.ok(Date.now() - started >= 700, 'blocked until the lock was released');
});

// ─────────────────────────────────────────────────────────────
// usermgr-worker.sh
// ─────────────────────────────────────────────────────────────
function workerEnv(t) {
  const dir = tmpDir(t);
  const spool = path.join(dir, 'spool');
  fs.mkdirSync(spool, { mode: 0o700 });
  fs.chmodSync(spool, 0o700);
  const log = path.join(dir, 'manage.log');
  const stub = writeExec(path.join(dir, 'manage-user-stub.sh'), `#!/bin/bash
( printf '%s' "$1"; shift; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n' ) >> "${log}"
if [[ "\${2:-}" == gw-fail* ]]; then echo "stub failure" >&2; exit 1; fi
echo "User '\${2:0:7}***' done."
`);
  const worker = patchScript(path.join(GATEWAY, 'usermgr-worker.sh'), path.join(dir, 'usermgr-worker.sh'), [
    [/^export PATH=.*$/m, pathLine('')],
    [/^\[\[ \$EUID -eq 0 \]\] \|\| fail "must run as root"$/m, ': # root check disabled for the test'],
  ]);
  const run = (spoolDir = spool, extraEnv = {}) => spawnSync('bash', [worker], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, TUNNELVAULT_USERMGR_SPOOL: spoolDir, TUNNELVAULT_SERVICE_USER: ME.username, TUNNELVAULT_MANAGE_USER: stub, ...extraEnv },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\x1f')) : []);
  const req = (name, content) => { fs.writeFileSync(path.join(spool, name), content, { mode: 0o600 }); };
  return { dir, spool, run, calls, req };
}

test('usermgr-worker: applies valid requests and rejects everything else', (t) => {
  const { dir, spool, run, calls, req } = workerEnv(t);
  const j = (o) => JSON.stringify(o);
  req('1700000000001-aaaaaaaaaaaa.req', j({ action: 'create', username: 'gw-alpha123456', publicKey: `  ${PUBKEY}  ` }));
  req('1700000000002-bbbbbbbbbbbb.req', j({ action: 'delete', username: 'gw-bravo' }));
  const outside = path.join(dir, 'outside.json');
  fs.writeFileSync(outside, j({ action: 'delete', username: 'gw-viasymlink' }));
  fs.symlinkSync(outside, path.join(spool, '1700000000003-cccccccccccc.req'));
  req('1700000000004-dddddddddddd.req', j({ action: 'delete', username: 'gw-big', pad: 'x'.repeat(16400) }));
  req('1700000000005-eeeeeeeeeeee.req', '{"action":"delete",');
  req('1700000000006-ffffffffffff.req', j(['delete', 'gw-array']));
  req('1700000000007-gggggggggggg.req', j({ action: 'chmod', username: 'gw-action' }));
  req('1700000000008-hhhhhhhhhhhh.req', j({ action: 'delete', username: `gw-${'a'.repeat(30)}` }));
  req('1700000000009-iiiiiiiiiiii.req', j({ action: 'delete', username: 'gw-a;rm -rf /' }));
  req('1700000000010-jjjjjjjjjjjj.req', j({ action: 'create', username: 'gw-keyinj', publicKey: 'ssh-ed25519 AAAA $(touch /tmp/pwned)' }));
  req('1700000000011-kkkkkkkkkkkk.req', j({ action: 'create', username: 'gw-keynl', publicKey: 'ssh-ed25519 AAAA\nssh-rsa BBBB' }));
  const hard = path.join(dir, 'hard.json');
  fs.writeFileSync(hard, j({ action: 'delete', username: 'gw-hardlink' }));
  fs.linkSync(hard, path.join(spool, '1700000000012-llllllllllll.req'));
  assert.equal(spawnSync('mkfifo', [path.join(spool, '1700000000013-mmmmmmmmmmmm.req')]).status, 0);
  fs.mkdirSync(path.join(spool, '1700000000014-nnnnnnnnnnnn.req'));
  req('evil.req', j({ action: 'delete', username: 'gw-evilname' }));
  req('.1700000000015-oooooooooooo.tmp', j({ action: 'delete', username: 'gw-tmpfile' }));
  req('1700000000016-pppppppppppp.req', j({ action: 'create', username: 'gw-failing', publicKey: PUBKEY }));
  req('1700000000018-rrrrrrrrrrrr.req', j({ action: 'create', username: 'gw-nokey' }));
  req('1700000000019-ssssssssssss.req', j({ action: 'delete', username: 'root' }));
  req('1700000000020-tttttttttttt.req', j({ action: 'create', username: 'gw-extra', publicKey: PUBKEY, requestedBy: 'api' }));
  req('1700000000021-uuuuuuuuuuuu.req', j({ action: 'create', username: 'gw-options', publicKey: `command="/bin/sh" ${PUBKEY}` }));
  if (ME.uid === 0) {
    req('1700000000017-qqqqqqqqqqqq.req', j({ action: 'delete', username: 'gw-foreign' }));
    fs.chownSync(path.join(spool, '1700000000017-qqqqqqqqqqqq.req'), 65534, 65534);
  }

  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.deepEqual(calls(), [
    ['create', 'gw-alpha123456', PUBKEY],
    ['delete', 'gw-bravo'],
    ['create', 'gw-failing', PUBKEY],
    ['create', 'gw-extra', PUBKEY],
  ]);
  assert.match(r.stdout, /FAILED create gw-fail\*\*\*/);
  assert.match(r.stdout, /done: 4 applied, \d+ rejected/);
  const rejected = Number(r.stdout.match(/(\d+) rejected/)[1]);
  assert.equal(rejected, ME.uid === 0 ? 17 : 16);
  assert.doesNotMatch(r.stdout, /gw-alpha123456/, 'full usernames (they contain the token) are not logged');

  const left = fs.readdirSync(spool);
  assert.deepEqual(left.filter((f) => f.endsWith('.req')), [], 'no *.req left behind (the path unit would loop)');
  assert.ok(left.includes('.1700000000015-oooooooooooo.tmp'), 'temp files of the writer are ignored');
  assert.ok(left.some((f) => f.startsWith('.rejected-1700000000013-')), 'FIFO set aside without blocking');
  assert.ok(left.some((f) => f.startsWith('.rejected-1700000000014-')), 'directory set aside');
  assert.ok(fs.existsSync(outside), 'symlink target untouched');
  assert.ok(fs.existsSync(hard), 'hard link target untouched');
  assert.ok(!fs.existsSync('/tmp/pwned'));

  // a second run has nothing to do
  const again = run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /done: 0 applied, 0 rejected/);
});

test('usermgr-worker: processes request files written by the backend userManager', async (t) => {
  const { spool, run, calls } = workerEnv(t);
  const prev = process.env.USERMGR_SPOOL_DIR;
  process.env.USERMGR_SPOOL_DIR = spool;
  t.after(() => { if (prev === undefined) delete process.env.USERMGR_SPOOL_DIR; else process.env.USERMGR_SPOOL_DIR = prev; });
  const userManager = require('../src/userManager');
  assert.deepEqual(await userManager.createLinuxUser('gw-fromapi1', PUBKEY), { ok: true, queued: true });
  assert.deepEqual(await userManager.deleteLinuxUser('gw-fromapi2'), { ok: true, queued: true });
  const files = fs.readdirSync(spool);
  assert.equal(files.length, 2);
  for (const f of files) assert.equal(fs.statSync(path.join(spool, f)).mode & 0o777, 0o600);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(), [['create', 'gw-fromapi1', PUBKEY], ['delete', 'gw-fromapi2']]);
});

test('usermgr-worker: refuses unsafe spool directories', (t) => {
  const { dir, spool, run, calls, req } = workerEnv(t);
  req('1700000000001-aaaaaaaaaaaa.req', JSON.stringify({ action: 'delete', username: 'gw-x' }));

  fs.chmodSync(spool, 0o770);
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must not be writable by group or others/);
  fs.chmodSync(spool, 0o700);

  const link = path.join(dir, 'spool-link');
  fs.symlinkSync(spool, link);
  r = run(link);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a directory|must not contain symlinks/);

  const parentLink = path.join(dir, 'parent-link');
  fs.symlinkSync(dir, parentLink);
  r = run(path.join(parentLink, 'spool'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must not contain symlinks/);

  r = run(path.join(dir, 'missing'));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to do/);

  r = run(spool, { TUNNELVAULT_SERVICE_USER: 'no-such-user-tv' });
  assert.equal(r.status, 1);

  if (ME.uid === 0) {
    fs.chownSync(spool, 65534, 65534);
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be owned by/);
    fs.chownSync(spool, 0, 0);
  }
  assert.deepEqual(calls(), [], 'nothing applied from an unsafe spool');
  assert.ok(fs.existsSync(path.join(spool, '1700000000001-aaaaaaaaaaaa.req')));
});

// ─────────────────────────────────────────────────────────────
// manage-user.sh (system commands stubbed)
// ─────────────────────────────────────────────────────────────
function manageEnv(t) {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  const install = path.join(dir, 'opt');
  for (const d of ['users', 'groups', 'home']) fs.mkdirSync(path.join(state, d), { recursive: true });
  writeExec(path.join(install, 'ssh_router.sh'), '#!/bin/bash\n');
  const stubs = path.join(dir, 'stubs');
  const log = path.join(state, 'calls.log');
  const logLine = `echo "$(basename "$0") $*" >> "${log}"`;
  writeExec(path.join(stubs, 'getent'), `#!/bin/bash
case "$1" in
  passwd) [[ -f "${state}/users/$2" ]] && cat "${state}/users/$2" && exit 0; exit 2 ;;
  group)  [[ -f "${state}/groups/$2" ]] && exit 0; exit 2 ;;
esac
exit 2
`);
  writeExec(path.join(stubs, 'id'), `#!/bin/bash
[[ "$1" == -u && -f "${state}/users/$2" ]] || exit 1
cut -d: -f3 "${state}/users/$2"
`);
  writeExec(path.join(stubs, 'groupadd'), `#!/bin/bash\n${logLine}\ntouch "${state}/groups/\${!#}"\n`);
  writeExec(path.join(stubs, 'useradd'), `#!/bin/bash
${logLine}
name="\${!#}"; shell=""
while [[ $# -gt 0 ]]; do [[ "$1" == --shell ]] && shell="$2"; shift; done
mkdir -p "${state}/home/$name"; chmod 0775 "${state}/home/$name"
echo "$name:x:1500:1500::${state}/home/$name:$shell" > "${state}/users/$name"
`);
  writeExec(path.join(stubs, 'usermod'), `#!/bin/bash\n${logLine}\n`);
  writeExec(path.join(stubs, 'userdel'), `#!/bin/bash\n${logLine}\nrm -f "${state}/users/\${!#}"\n`);
  writeExec(path.join(stubs, 'chown'), `#!/bin/bash\n${logLine}\n`);
  writeExec(path.join(stubs, 'pkill'), `#!/bin/bash\n${logLine}\nexit 1\n`);
  writeExec(path.join(stubs, 'pgrep'), '#!/bin/bash\nexit 1\n');
  const script = patchScript(path.join(GATEWAY, 'manage-user.sh'), path.join(dir, 'manage-user.sh'), [
    [/^readonly INSTALL_DIR=.*$/m, `readonly INSTALL_DIR="${install}"`],
    [/^export PATH=.*$/m, pathLine(stubs)],
    [/^\[\[ \$EUID -eq 0 \]\] \|\| die "manage-user.sh must run as root"$/m, ': # root check disabled for the test'],
  ]);
  const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  const callLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { state, install, run, callLog };
}

test('manage-user: validates usernames and keys before doing anything', (t) => {
  const { run, callLog } = manageEnv(t);
  const bad = [
    [['create', `gw-${'a'.repeat(30)}`, PUBKEY], /Invalid username/],
    [['create', 'root', PUBKEY], /Invalid username/],
    [['create', 'gw-a;id', PUBKEY], /Invalid username/],
    [['create', 'gw-abc', `command="/bin/sh" ${PUBKEY}`], /Invalid SSH public key/],
    [['create', 'gw-abc', 'ssh-ed25519 AAAA $(id)'], /Invalid SSH public key/],
    [['create', 'gw-abc', 'ssh-ed25519 AAAA `id`'], /Invalid SSH public key/],
    [['create', 'gw-abc', 'ssh-ed25519 AAAA\nssh-rsa BBBB'], /Invalid SSH public key/],
    [['create', 'gw-abc', 'ssh-ed25519 AAAA "quoted"'], /Invalid SSH public key/],
    [['create', 'gw-abc', 'ssh-unknown AAAA'], /Invalid SSH public key/],
    [['create', 'gw-abc', `ssh-ed25519 ${'A'.repeat(8200)}`], /Invalid SSH public key/],
    [['create', 'gw-abc'], /Usage/],
    [['delete', 'gw-abc', 'extra'], /Usage/],
    [['chmod', 'gw-abc'], /Unknown action/],
    [[], /Username is required/],
  ];
  for (const [args, re] of bad) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.equal(callLog(), '', 'no system command was run');
});

test('manage-user: create makes a restricted, root-owned authorized_keys', (t) => {
  const { state, install, run, callLog } = manageEnv(t);
  const r = run('create', 'gw-abcdef123456', PUBKEY);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /User 'gw-abcd\*\*\*' created\./);
  assert.doesNotMatch(r.stdout, /gw-abcdef123456/, 'full username (token) not printed');
  const calls = callLog();
  assert.match(calls, /^groupadd --system tunnelvault-gw$/m);
  assert.match(calls, new RegExp(`^useradd --system --create-home --shell ${install}/ssh_router\\.sh --groups tunnelvault-gw gw-abcdef123456$`, 'm'));
  assert.match(calls, /^chown root:root -- .*\/home\/gw-abcdef123456\/\.ssh$/m);
  const home = path.join(state, 'home', 'gw-abcdef123456');
  assert.equal(fs.statSync(home).mode & 0o022, 0, 'home not group/world writable');
  const keys = path.join(home, '.ssh', 'authorized_keys');
  assert.equal(fs.readFileSync(keys, 'utf8'), `restrict ${PUBKEY}\n`);
  assert.equal(fs.statSync(keys).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(path.join(home, '.ssh')), ['authorized_keys'], 'no temp file left');
});

test('manage-user: updating an existing user replaces a planted .ssh symlink', (t) => {
  const { state, run, callLog } = manageEnv(t);
  const home = path.join(state, 'home', 'gw-existing');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(state, 'users', 'gw-existing'), `gw-existing:x:1501:1501::${home}:/bin/false\n`);
  fs.writeFileSync(path.join(state, 'groups', 'tunnelvault-gw'), '');
  const victim = path.join(state, 'victim');
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, path.join(home, '.ssh'));
  const r = run('create', 'gw-existing', PUBKEY);
  assert.equal(r.status, 0, r.stderr);
  assert.match(callLog(), /^usermod --shell .*ssh_router\.sh --append --groups tunnelvault-gw gw-existing$/m);
  assert.doesNotMatch(callLog(), /^useradd/m);
  assert.deepEqual(fs.readdirSync(victim), [], 'symlink target untouched');
  assert.ok(fs.lstatSync(path.join(home, '.ssh')).isDirectory());
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), `restrict ${PUBKEY}\n`);

  // UID 0 accounts are never touched
  fs.writeFileSync(path.join(state, 'users', 'gw-uidzero'), `gw-uidzero:x:0:0::${home}:/bin/bash\n`);
  const z = run('create', 'gw-uidzero', PUBKEY);
  assert.equal(z.status, 1);
  assert.match(z.stderr, /UID 0/);
  assert.equal(run('delete', 'gw-uidzero').status, 1);
});

test('manage-user: delete terminates sessions and removes the user', (t) => {
  const { state, run, callLog } = manageEnv(t);
  fs.writeFileSync(path.join(state, 'users', 'gw-gone1234'), `gw-gone1234:x:1502:1502::${state}/home/x:/bin/false\n`);
  const r = run('delete', 'gw-gone1234');
  assert.equal(r.status, 0, r.stderr);
  assert.match(callLog(), /^pkill -TERM -u gw-gone1234$/m);
  assert.match(callLog(), /^userdel --remove gw-gone1234$/m);
  assert.match(r.stdout, /User 'gw-gone\*\*\*' deleted\./);
  const again = run('delete', 'gw-gone1234');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /does not exist/);
});

// ─────────────────────────────────────────────────────────────
// ssh_router.sh (sudo, helper, nc and logger stubbed)
// ─────────────────────────────────────────────────────────────
function routerEnv(t) {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  const install = path.join(dir, 'opt');
  const stubs = path.join(dir, 'stubs');
  fs.mkdirSync(state, { recursive: true });
  const calls = path.join(state, 'calls');
  fs.writeFileSync(path.join(state, 'id_user'), 'gw-tok1secret\n');
  fs.writeFileSync(path.join(state, 'row'), '10.0.0.5|2222|1\n');
  fs.writeFileSync(path.join(state, 'lookup_rc'), '0');
  writeExec(path.join(stubs, 'id'), `#!/bin/bash\nif [[ "$1" == -un ]]; then cat "${state}/id_user"; else exec /usr/bin/id "$@"; fi\n`);
  writeExec(path.join(stubs, 'sudo'), `#!/bin/bash
echo "sudo $*" >> "${calls}"
while [[ $# -gt 0 ]]; do case "$1" in -u) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac; done
exec "$@"
`);
  writeExec(path.join(stubs, 'logger'), `#!/bin/bash\necho "logger $*" >> "${state}/syslog"\n`);
  writeExec(path.join(stubs, 'nc'), `#!/bin/bash\necho "nc $*" >> "${calls}"\nexec cat\n`);
  writeExec(path.join(install, 'gateway-helper.sh'), `#!/bin/bash
echo "helper $*" >> "${calls}"
case "$1" in
  lookup) cat "${state}/row"; exit "$(cat "${state}/lookup_rc")" ;;
  session-start) [[ -f "${state}/start_fail" ]] && exit 1; echo 42 ;;
  session-end) exit 0 ;;
esac
`);
  const router = patchScript(path.join(GATEWAY, 'ssh_router.sh'), path.join(dir, 'ssh_router.sh'), [
    [/^readonly INSTALL_DIR=.*$/m, `readonly INSTALL_DIR="${install}"`],
    [/^export PATH=.*$/m, pathLine(stubs)],
  ]);
  const env = { ...process.env, SSH_CLIENT: '203.0.113.9 51234 22' };
  const run = (input = 'ssh-stream\n', extraEnv = {}) => {
    const e = { ...env, ...extraEnv };
    for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
    return spawnSync('bash', [router, '-c', 'ignored command'], { encoding: 'utf8', input, env: e, timeout: 30000 });
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { state, router, env, run, calls: () => read(calls), syslog: () => read(path.join(state, 'syslog')) };
}

test('ssh_router: relays the SSH stream to the token target and records the session', (t) => {
  const { run, calls, syslog } = routerEnv(t);
  const r = run('SSH-2.0-client\nbinary\x00data\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'SSH-2.0-client\nbinary\x00data\n', 'stdin passed through to nc');
  const c = calls();
  assert.match(c, /^sudo -n -u tunnelvault -- .*gateway-helper\.sh lookup$/m);
  assert.match(c, /^helper session-start 203\.0\.113\.9 \d+$/m);
  assert.match(c, /^nc -q0 10\.0\.0\.5 2222$/m);
  assert.match(c, /^helper session-end 42$/m);
  assert.ok(c.indexOf('helper lookup') < c.indexOf('nc -q0'));
  assert.match(syslog(), /SESSION_START id=42 client=203\.0\.113\.9 target=10\.0\.0\.5:2222/);
  assert.match(syslog(), /user=gw-tok1\*\*\*/);
  assert.doesNotMatch(syslog(), /tok1secret/, 'token never logged in full');
});

test('ssh_router: denies unknown/disabled tokens and bad targets', (t) => {
  const { state, run, calls } = routerEnv(t);
  const cases = [
    () => fs.writeFileSync(path.join(state, 'lookup_rc'), '3'),
    () => fs.writeFileSync(path.join(state, 'lookup_rc'), '1'),
    () => fs.writeFileSync(path.join(state, 'row'), '10.0.0.5|2222|0\n'),
    () => fs.writeFileSync(path.join(state, 'row'), '10.0.0.300|22|1\n'),
    () => fs.writeFileSync(path.join(state, 'row'), '10.0.0.5;touch /tmp/x|22|1\n'),
    () => fs.writeFileSync(path.join(state, 'row'), '10.0.0.5|0|1\n'),
    () => fs.writeFileSync(path.join(state, 'row'), '10.0.0.5|70000|1\n'),
    () => fs.writeFileSync(path.join(state, 'row'), '|22|1\n'),
    () => fs.writeFileSync(path.join(state, 'id_user'), 'alice\n'),
  ];
  for (const [i, setup] of cases.entries()) {
    fs.writeFileSync(path.join(state, 'row'), '10.0.0.5|2222|1\n');
    fs.writeFileSync(path.join(state, 'lookup_rc'), '0');
    fs.writeFileSync(path.join(state, 'id_user'), 'gw-tok1\n');
    fs.rmSync(path.join(state, 'calls'), { force: true });
    setup();
    const r = run();
    assert.equal(r.status, 1, `case ${i}`);
    assert.match(r.stderr, /TunnelVault gateway:/, `case ${i}`);
    assert.equal(r.stdout, '', `case ${i}`);
    assert.doesNotMatch(calls(), /^nc /m, `case ${i}: no connection`);
    assert.doesNotMatch(calls(), /session-start/, `case ${i}: no session`);
  }
});

test('ssh_router: hostile SSH_CLIENT and failed session recording', (t) => {
  const { state, run, calls } = routerEnv(t);
  let r = run('x', { SSH_CLIENT: "1.2.3.4';DROP 5 6" });
  assert.equal(r.status, 0);
  assert.match(calls(), /^helper session-start - \d+$/m);
  fs.rmSync(path.join(state, 'calls'));
  r = run('no ssh env', { SSH_CLIENT: null });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no ssh env');
  assert.match(calls(), /^helper session-start - \d+$/m);
  fs.rmSync(path.join(state, 'calls'));
  fs.writeFileSync(path.join(state, 'start_fail'), '');
  r = run('still connects');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'still connects');
  assert.match(calls(), /^nc -q0/m);
  assert.doesNotMatch(calls(), /session-end/);
});

test('ssh_router: closes the session when terminated', async (t) => {
  const { router, env, calls } = routerEnv(t);
  const child = spawn('bash', [router], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (/^nc -q0/m.test(calls())) return resolve();
      if (Date.now() > deadline) return reject(new Error(`nc never started: ${calls()}`));
      setTimeout(poll, 50);
    };
    poll();
  });
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('close', (c, sig) => resolve(c ?? sig)));
  assert.equal(code, 143);
  assert.match(calls(), /^helper session-end 42$/m);
});

// ─────────────────────────────────────────────────────────────
// register_token.sh (runuser + manage-user stubbed, real sqlite3 + schema)
// ─────────────────────────────────────────────────────────────
function registerEnv(t) {
  const dir = tmpDir(t);
  const install = path.join(dir, 'opt');
  const stubs = path.join(dir, 'stubs');
  const dbPath = path.join(install, 'data', 'tunnelvault.db');
  fs.mkdirSync(path.join(install, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(install, 'backend', '.env'), `DB_PATH=${dbPath}\n`);
  const db = initDb(dbPath);
  t.after(() => db.close());
  const log = path.join(dir, 'calls.log');
  writeExec(path.join(stubs, 'runuser'), `#!/bin/bash
echo "runuser $1 $2" >> "${log}"
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift
exec "$@"
`);
  writeExec(path.join(stubs, 'pkill'), `#!/bin/bash\necho "pkill $*" >> "${log}"\n`);
  writeExec(path.join(stubs, 'getent'), '#!/bin/bash\n[[ "$1" == passwd && "$2" == gw-* ]]\n');
  const manage = writeExec(path.join(dir, 'manage-stub.sh'), `#!/bin/bash
( printf '%s' "manage $1"; shift; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\n' ) >> "${log}"
`);
  const script = patchScript(path.join(GATEWAY, 'register_token.sh'), path.join(dir, 'register_token.sh'), [
    [/^readonly INSTALL_DIR=.*$/m, `readonly INSTALL_DIR="${install}"`],
    [/^readonly SERVICE_USER=.*$/m, `readonly SERVICE_USER="${ME.username}"`],
    [/^readonly MANAGE_USER=.*$/m, `readonly MANAGE_USER="${manage}"`],
    [/^export PATH=.*$/m, pathLine(stubs)],
    [/^\[\[ \$EUID -eq 0 \]\] \|\| die "Please run as root \(sudo\)\."$/m, ': # root check disabled for the test'],
  ]);
  const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  const callLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  return { db, run, callLog, dbPath, install };
}

test('register_token: create/update/list/disable/enable/delete against the backend schema', needSqlite, (t) => {
  const { db, run, callLog } = registerEnv(t);
  const label = `Acme's "dev" box; DROP TABLE tokens; -- ${'é'}`;
  let r = run('--token', 'abcDEF123', '--ip', '10.1.2.3', '--port', '2222', '--label', label, '--pubkey', `  ${PUBKEY}  `);
  assert.equal(r.status, 0, r.stderr);
  let row = db.prepare("SELECT * FROM tokens WHERE token = 'abcDEF123'").get();
  assert.equal(row.label, label, 'label stored verbatim (hex literal, no injection)');
  assert.equal(row.target_ip, '10.1.2.3');
  assert.equal(row.target_port, 2222);
  assert.equal(row.public_key, PUBKEY, 'key trimmed like the API');
  assert.equal(row.linux_user, 'gw-abcDEF123');
  assert.equal(row.active, 1);
  assert.match(callLog(), new RegExp(`^runuser -u ${ME.username}$`, 'm'), 'SQL runs as the service user');
  assert.ok(callLog().includes(`manage create\x1fgw-abcDEF123\x1f${PUBKEY}\n`));

  // update keeps the label unless --label is given
  r = run('--token', 'abcDEF123', '--ip', '10.1.2.4', '--pubkey', PUBKEY);
  assert.equal(r.status, 0, r.stderr);
  row = db.prepare("SELECT * FROM tokens WHERE token = 'abcDEF123'").get();
  assert.equal(row.label, label);
  assert.equal(row.target_ip, '10.1.2.4');
  assert.equal(row.target_port, 22);

  // list sanitises control characters in labels written through the API
  db.prepare("INSERT INTO tokens (token, label, target_ip, linux_user) VALUES ('apitoken', ?, '', 'ws-apitoken')").run('evil\x1b[2J\u009b1mBüro');
  r = run('--list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /abcDEF123/);
  assert.match(r.stdout, /evil\?\[2J\?1mBüro/, 'C0/C1 controls replaced, UTF-8 text kept');
  assert.doesNotMatch(r.stdout, /[\x1b\u009b]/);

  r = run('--disable', 'abcDEF123');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare("SELECT active FROM tokens WHERE token = 'abcDEF123'").get().active, 0);
  assert.match(callLog(), /^pkill -TERM -u gw-abcDEF123$/m, 'live gateway sessions terminated');
  r = run('--enable', 'abcDEF123');
  assert.equal(r.status, 0);
  assert.equal(db.prepare("SELECT active FROM tokens WHERE token = 'abcDEF123'").get().active, 1);
  assert.equal(run('--disable', 'nosuchtoken').status, 1);

  // delete removes the token, its sessions and host-key pins (not other tokens' pins)
  db.prepare("INSERT INTO sessions (token, client_ip) VALUES ('abcDEF123', '1.1.1.1'), ('apitoken', '2.2.2.2')").run();
  db.prepare("INSERT INTO ssh_host_keys (pin_key, fingerprint) VALUES ('token:abcDEF123:22', 'SHA256:a'), ('token:abcDEF1234:22', 'SHA256:b'), ('tunnel:x', 'SHA256:c')").run();
  r = run('--delete', 'abcDEF123');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tokens WHERE token = 'abcDEF123'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE token = 'abcDEF123'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE token = 'apitoken'").get().n, 1);
  assert.deepEqual(db.prepare('SELECT pin_key FROM ssh_host_keys ORDER BY pin_key').all().map((x) => x.pin_key),
    ['token:abcDEF1234:22', 'tunnel:x']);
  assert.ok(callLog().includes('manage delete\x1fgw-abcDEF123\n'));
  assert.equal(run('--delete', 'abcDEF123').status, 1, 'unknown token');
});

test('register_token: input validation', needSqlite, (t) => {
  const { run, db } = registerEnv(t);
  const bad = [
    [['--token', 'a'.repeat(30), '--ip', '10.0.0.1', '--pubkey', PUBKEY], /limited to 29/],
    [['--token', 'abc-def', '--ip', '10.0.0.1', '--pubkey', PUBKEY], /letters and digits/],
    [['--token', 'abc', '--ip', '10.0.0.256', '--pubkey', PUBKEY], /Invalid IPv4/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--port', '0', '--pubkey', PUBKEY], /Invalid port/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--port', '65536', '--pubkey', PUBKEY], /Invalid port/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--label', 'a\nb', '--pubkey', PUBKEY], /control characters/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--label', 'a\x1b[2Jb', '--pubkey', PUBKEY], /control characters/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--pubkey', 'ssh-ed25519 AAAA $(id)'], /Invalid SSH public key/],
    [['--token', 'abc', '--ip', '10.0.0.1', '--pubkey', `restrict ${PUBKEY}`], /Invalid SSH public key/],
    [['--delete', "x' OR '1'='1"], /Invalid token format/],
    [['--token'], /requires a value/],
  ];
  for (const [args, re] of bad) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM tokens').get().n, 0);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--delete/);
});

test('register_token: refuses a database without the backend schema', needSqlite, (t) => {
  const { run, dbPath } = registerEnv(t);
  fs.rmSync(dbPath, { force: true });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  let r = run('--list');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found — start the service first/);
  fs.writeFileSync(dbPath, '');
  r = run('--list');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /schema missing/);
});

test('gateway sudoers file is valid and grants only the helper', (t) => {
  const file = path.join(GATEWAY, 'tunnelvault-sudoers');
  const text = fs.readFileSync(file, 'utf8');
  const rules = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('Defaults'));
  assert.deepEqual(rules, ['%tunnelvault-gw ALL=(tunnelvault) NOPASSWD: /opt/tunnelvault/gateway-helper.sh']);
  assert.doesNotMatch(rules.join('\n'), /\(root\)|\(ALL/, 'no root rule');
  const visudo = which('visudo');
  if (!visudo) return t.diagnostic('visudo not available');
  const r = spawnSync(visudo, ['-c', '-f', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
