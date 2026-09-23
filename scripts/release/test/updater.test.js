'use strict';
// Tests for auto-update-client.sh / auto-update.sh against a local fake GitHub
// (HTTP on loopback and HTTPS with a throwaway CA). The release tarballs carry
// STUB installers that only record how they were called — no real installer runs
// and nothing outside the test's temp directory is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  REPO_ROOT, mkTmp, mustRun, runAsync, makeKey, makeReleaseRepo, makeFrontendDist, makeCert,
  startReleaseServer, craftTarGz, writeSignedRelease,
} = require('./helpers');

const CLIENT_UPDATER = path.join(REPO_ROOT, 'auto-update-client.sh');
const SERVER_UPDATER = path.join(REPO_ROOT, 'auto-update.sh');

const STUB = `#!/bin/bash
set -e
printf 'script=%s\\nargs=%s\\nversion=%s\\nupdater=%s\\n' "$(basename "$0")" "$*" "$(cat VERSION)" "\${TUNNELVAULT_UPDATER:-}" > "$STUB_MARKER"
echo "stub installer ran"
exit "\${STUB_EXIT:-0}"
`;

let fx; // shared fixtures (built once)

test.before(() => {
  const root = mkTmp(null, 'tv-updater-fixtures-');
  const keys = makeKey(path.join(root, 'key'));
  const other = makeKey(path.join(root, 'other-key'));
  const dist = makeFrontendDist(path.join(root, 'dist'));
  const releases = {};
  for (const version of ['2.0.1', '2.1.0']) {
    const repo = makeReleaseRepo(path.join(root, `repo-${version}`), {
      version,
      pubkey: keys.pub,
      files: { 'install-client.sh': STUB, 'install-server.sh': STUB },
    });
    const out = path.join(root, `rel-${version}`);
    mustRun('bash', [path.join(repo, 'scripts/release/build-release.sh'), version,
      '--frontend-dist', dist, '--out', out, '--key', keys.key], { cwd: repo });
    releases[`v${version}`] = out;
  }
  // Tampered: valid signature/SUMS copied from v2.0.1, tarball modified.
  const tampered = path.join(root, 'rel-tampered');
  fs.cpSync(releases['v2.0.1'], tampered, { recursive: true });
  const tb = path.join(tampered, 'tunnelvault-v2.0.1.tar.gz');
  const buf = fs.readFileSync(tb);
  buf[buf.length - 30] ^= 0x55;
  fs.writeFileSync(tb, buf);

  // Hostile archives that ARE correctly signed (defence in depth after verification).
  const p = 'tunnelvault-v2.0.1';
  const base = [
    { name: `${p}/`, type: 'dir' },
    { name: `${p}/VERSION`, type: 'file', content: '2.0.1\n' },
    { name: `${p}/install-client.sh`, type: 'file', content: STUB },
  ];
  const hostile = {
    dotdot: [...base, { name: `${p}/../escaped-by-dotdot`, type: 'file', content: 'x' }],
    absolute: [...base, { name: '/tmp/tv-absolute-escape', type: 'file', content: 'x' }],
    symlink: [...base, { name: `${p}/link`, type: 'symlink', linkname: '/etc' }],
    hardlink: [...base, { name: `${p}/hard`, type: 'hardlink', linkname: '/etc/passwd' }],
    outside: [...base, { name: 'other-dir/file', type: 'file', content: 'x' }],
    versionMismatch: [
      { name: `${p}/`, type: 'dir' },
      { name: `${p}/VERSION`, type: 'file', content: '2.0.0\n' },
      { name: `${p}/install-client.sh`, type: 'file', content: STUB },
    ],
    noInstaller: [{ name: `${p}/`, type: 'dir' }, { name: `${p}/VERSION`, type: 'file', content: '2.0.1\n' }],
  };
  const hostileDirs = {};
  for (const [k, entries] of Object.entries(hostile)) {
    hostileDirs[k] = writeSignedRelease(path.join(root, `hostile-${k}`), 'v2.0.1', craftTarGz(entries), keys.key);
  }
  fx = { root, keys, other, releases, tampered, hostileDirs };
});

test.after(() => {
  if (fx) fs.rmSync(fx.root, { recursive: true, force: true });
});

/** Per-test sandbox: config, install dir with VERSION, log, lock, TMPDIR, marker. */
function sandbox(t, { installed = '2.0.0', conf = {}, pubkey } = {}) {
  const dir = mkTmp(t, 'tv-updater-');
  const etc = path.join(dir, 'etc');
  fs.mkdirSync(etc, { mode: 0o755 });
  const pub = path.join(etc, 'release-signing.pub');
  fs.copyFileSync(pubkey || fx.keys.pub, pub);
  fs.chmodSync(pub, 0o644);
  const install = path.join(dir, 'install');
  fs.mkdirSync(install);
  if (installed !== null) fs.writeFileSync(path.join(install, 'VERSION'), `${installed}\n`);
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const settings = { ENABLED: '1', SCHEDULE: '12h', UPDATE_REPO: 'TrainABit/ssh-tunnel', PINNED_VERSION: '', PUBKEY: pub, ...conf };
  const confFile = path.join(etc, 'update.conf');
  fs.writeFileSync(confFile, `# test\n${Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o644 });
  return {
    dir, etc, pub, install, tmpdir, confFile,
    log: path.join(dir, 'update.log'),
    lock: path.join(dir, 'update.lock'),
    marker: path.join(dir, 'installer-ran'),
  };
}

function updaterEnv(sb, server, extra = {}) {
  const env = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  return {
    ...env,
    NO_PROXY: '*',
    no_proxy: '*',
    TMPDIR: sb.tmpdir,
    TUNNELVAULT_UPDATE_CONF: sb.confFile,
    TUNNELVAULT_INSTALL_DIR: sb.install,
    TUNNELVAULT_UPDATE_LOG: sb.log,
    TUNNELVAULT_UPDATE_LOCK: sb.lock,
    UPDATE_BASE_URL: server ? `${server.url}/download` : 'https://127.0.0.1:1/download',
    UPDATE_API_URL: server ? `${server.url}/api/latest` : 'https://127.0.0.1:1/api/latest',
    STUB_MARKER: sb.marker,
    ...extra,
  };
}

function runUpdater(sb, server, { updater = CLIENT_UPDATER, args = [], env = {} } = {}) {
  return runAsync('bash', [updater, ...args], { cleanEnv: true, env: updaterEnv(sb, server, env), timeoutMs: 60000 });
}

function marker(sb) {
  if (!fs.existsSync(sb.marker)) return null;
  return Object.fromEntries(fs.readFileSync(sb.marker, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

async function withServer(t, opts) {
  const server = await startReleaseServer({ latest: 'v2.0.1', releases: fx.releases, ...opts });
  t.after(() => server.close());
  return server;
}

test('client updater installs a newer verified release via install-client.sh --upgrade', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t);
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(marker(sb), { script: 'install-client.sh', args: '--upgrade', version: '2.0.1', updater: '1' });
  assert.match(res.stderr, /Signature and checksum verified/);
  assert.match(res.stderr, /\| stub installer ran/);
  assert.match(res.stderr, /Update to v2\.0\.1 complete/);
  assert.match(fs.readFileSync(sb.log, 'utf8'), /Update to v2\.0\.1 complete/);
  assert.deepEqual(server.requests, [
    '/api/latest',
    '/download/v2.0.1/tunnelvault-v2.0.1.tar.gz',
    '/download/v2.0.1/SHA256SUMS',
    '/download/v2.0.1/SHA256SUMS.sig',
  ]);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), [], 'staging directory must be removed');
});

test('server updater over HTTPS runs install-server.sh --upgrade --yes', async (t) => {
  const certDir = mkTmp(t);
  const tls = makeCert(certDir);
  const server = await withServer(t, { tls, latest: 'v2.1.0' });
  const sb = sandbox(t, { installed: '2.0.1' });
  const res = await runUpdater(sb, server, { updater: SERVER_UPDATER, env: { CURL_CA_BUNDLE: tls.cert } });
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(marker(sb), { script: 'install-server.sh', args: '--upgrade --yes', version: '2.1.0', updater: '1' });

  // Without trusting the throwaway CA the TLS handshake fails -> nothing installed.
  fs.rmSync(sb.marker);
  fs.writeFileSync(path.join(sb.install, 'VERSION'), '2.0.1\n');
  const bad = await runUpdater(sb, server, { updater: SERVER_UPDATER, env: { CURL_CA_BUNDLE: path.join(certDir, 'missing.pem'), SSL_CERT_FILE: '/nonexistent' } });
  assert.equal(bad.status, 1, bad.out);
  assert.equal(marker(sb), null);
});

test('already up to date -> no download, no install', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t, { installed: '2.0.1' });
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /Up to date \(v2\.0\.1\)/);
  assert.equal(marker(sb), null);
  assert.deepEqual(server.requests, ['/api/latest']);
});

test('never downgrades (latest older -> skip; pinned older -> error)', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t, { installed: '2.1.0' });
  let res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /refusing to downgrade/);
  assert.equal(marker(sb), null);

  const sb2 = sandbox(t, { installed: '2.1.0', conf: { PINNED_VERSION: '2.0.1' } });
  res = await runUpdater(sb2, server);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /refusing to downgrade/);
  assert.equal(marker(sb2), null);
  assert.ok(!server.requests.some((r) => r.startsWith('/download/')), 'nothing downloaded');

  // 2.0.10 > 2.0.9 (version sort, not string sort)
  const sb3 = sandbox(t, { installed: '2.0.10' });
  res = await runUpdater(sb3, server);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /refusing to downgrade/);
});

test('PINNED_VERSION installs that release without querying the API', async (t) => {
  const server = await withServer(t, { latest: 'v2.0.1' });
  const sb = sandbox(t, { installed: '2.0.0', conf: { PINNED_VERSION: 'v2.1.0' } });
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.equal(marker(sb).version, '2.1.0');
  assert.ok(!server.requests.includes('/api/latest'));
});

test('tampered tarball is rejected before extraction', async (t) => {
  const server = await withServer(t, { releases: { 'v2.0.1': fx.tampered } });
  const sb = sandbox(t);
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /CHECKSUM MISMATCH/);
  assert.match(res.stderr, /FAILED signature\/checksum verification/);
  assert.equal(marker(sb), null);
  assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
});

test('release signed by a different key is rejected', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t, { pubkey: fx.other.pub });
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /SIGNATURE VERIFICATION FAILED/);
  assert.equal(marker(sb), null);
});

test('missing signature file fails closed', async (t) => {
  const partial = mkTmp(t);
  fs.copyFileSync(path.join(fx.releases['v2.0.1'], 'tunnelvault-v2.0.1.tar.gz'), path.join(partial, 'tunnelvault-v2.0.1.tar.gz'));
  fs.copyFileSync(path.join(fx.releases['v2.0.1'], 'SHA256SUMS'), path.join(partial, 'SHA256SUMS'));
  const server = await withServer(t, { releases: { 'v2.0.1': partial } });
  const sb = sandbox(t);
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /download of SHA256SUMS\.sig failed/);
  assert.equal(marker(sb), null);
});

for (const [kind, pattern] of [
  ['dotdot', /'\.\.' path/],
  ['absolute', /absolute path/],
  ['symlink', /links or special files/],
  ['hardlink', /links or special files/],
  ['outside', /outside tunnelvault-v2\.0\.1\//],
  ['versionMismatch', /does not match the tag v2\.0\.1/],
  ['noInstaller', /has no install-client\.sh/],
]) {
  test(`correctly signed but hostile archive is rejected: ${kind}`, async (t) => {
    const server = await withServer(t, { releases: { 'v2.0.1': fx.hostileDirs[kind] } });
    const sb = sandbox(t);
    const res = await runUpdater(sb, server);
    assert.equal(res.status, 1, res.out);
    assert.match(res.stderr, /Signature and checksum verified/);
    assert.match(res.stderr, pattern);
    assert.equal(marker(sb), null);
    assert.equal(fs.existsSync(path.join(sb.tmpdir, 'escaped-by-dotdot')), false);
    assert.equal(fs.existsSync('/tmp/tv-absolute-escape'), false);
    assert.deepEqual(fs.readdirSync(sb.tmpdir), []);
  });
}

test('only HTTPS (or loopback HTTP) URLs are accepted', async (t) => {
  const sb = sandbox(t);
  for (const url of ['http://example.com/download', 'http://10.0.0.1/x', 'ftp://127.0.0.1/x', 'file:///etc', 'https://evil.example/x?y=1']) {
    const res = await runUpdater(sb, null, { env: { UPDATE_API_URL: url } });
    assert.equal(res.status, 1, `${url}: ${res.out}`);
    assert.match(res.stderr, /refusing non-HTTPS URL/);
  }
  assert.equal(marker(sb), null);
});

test('installer failure is reported as a failed update', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t);
  const res = await runUpdater(sb, server, { env: { STUB_EXIT: '3' } });
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /install-client\.sh failed while installing v2\.0\.1/);
});

test('--dry-run verifies and extracts but does not install', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t);
  const res = await runUpdater(sb, server, { args: ['--dry-run'] });
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /Dry run: v2\.0\.1 downloaded, verified and extracted/);
  assert.equal(marker(sb), null);
});

test('ENABLED=0 exits without network access', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t, { conf: { ENABLED: '0' } });
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /disabled/);
  assert.deepEqual(server.requests, []);
});

test('update.conf is parsed, never executed, and must not be writable by others', async (t) => {
  const server = await withServer(t);
  const canary = path.join(mkTmp(t), 'canary');
  const sb = sandbox(t, { conf: { PINNED_VERSION: `$(touch ${canary})` } });
  let res = await runUpdater(sb, server);
  assert.equal(res.status, 1, res.out);
  assert.match(res.stderr, /PINNED_VERSION must be X\.Y\.Z/);
  assert.equal(fs.existsSync(canary), false);

  const sb2 = sandbox(t);
  fs.appendFileSync(sb2.confFile, 'this is not a setting\n');
  res = await runUpdater(sb2, server);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not KEY=VALUE/);

  const sb3 = sandbox(t);
  fs.chmodSync(sb3.confFile, 0o666);
  res = await runUpdater(sb3, server);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /writable by group\/others/);

  const sb4 = sandbox(t);
  fs.chmodSync(sb4.pub, 0o666);
  res = await runUpdater(sb4, server);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /release public key .* writable/);

  const sb5 = sandbox(t, { conf: { UPDATE_REPO: 'evil/../repo' } });
  res = await runUpdater(sb5, server);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /UPDATE_REPO/);
  assert.equal(marker(sb5), null);
});

test('invalid latest-release metadata fails closed', async (t) => {
  for (const latest of [{ tag_name: 'v2.0.1-rc1' }, { tag_name: '2.0.1' }, { tag_name: 'v2.0.1', prerelease: true }, {}]) {
    const server = await startReleaseServer({ latest, releases: fx.releases });
    const sb = sandbox(t);
    const res = await runUpdater(sb, server);
    await server.close();
    assert.equal(res.status, 1, `${JSON.stringify(latest)}: ${res.out}`);
    assert.match(res.stderr, /no valid tag_name/);
    assert.equal(marker(sb), null);
  }
});

test('unknown installed version is treated as an upgrade', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t, { installed: null });
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /installed version unknown/);
  assert.equal(marker(sb).version, '2.0.1');
});

test('concurrent runs are serialised with flock', async (t) => {
  const server = await withServer(t);
  const sb = sandbox(t);
  const holder = spawn('flock', [sb.lock, 'sleep', '5'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  // Wait until the lock is actually held.
  for (let i = 0; i < 50; i++) {
    const probe = mustRun('bash', ['-c', `flock -n "${sb.lock}" true && echo free || echo held`]).stdout.trim();
    if (probe === 'held') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await runUpdater(sb, server);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stderr, /Another update run holds/);
  assert.equal(marker(sb), null);
  assert.deepEqual(server.requests, []);
});
