'use strict';
// End-to-end tests of the signed-release pipeline:
// generate-signing-key.sh -> build-release.sh -> sign-release.sh -> verify-release.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  REPO_ROOT, RELEASE_DIR, mkTmp, run, mustRun, makeKey, makeReleaseRepo, makeFrontendDist, block, shellcheckBin,
} = require('./helpers');

const VERIFY = path.join(RELEASE_DIR, 'verify-release.sh');

function setup(t, { version = '2.0.1', pinned = true } = {}) {
  const tmp = mkTmp(t);
  const keys = makeKey(path.join(tmp, 'key'));
  const repo = makeReleaseRepo(path.join(tmp, 'repo'), {
    version,
    pubkey: pinned ? keys.pub : undefined,
    files: { 'install-client.sh': '#!/bin/bash\necho stub\n' },
  });
  const dist = makeFrontendDist(path.join(tmp, 'dist'));
  const out = path.join(tmp, 'out');
  return { tmp, keys, repo, dist, out, version };
}

function build(ctx, extra = []) {
  return run('bash', [
    path.join(ctx.repo, 'scripts', 'release', 'build-release.sh'), ctx.version,
    '--frontend-dist', ctx.dist, '--out', ctx.out, '--key', ctx.keys.key, ...extra,
  ], { cwd: ctx.repo });
}

const tarballOf = (ctx) => path.join(ctx.out, `tunnelvault-v${ctx.version}.tar.gz`);
const verify = (ctx, pub = ctx.keys.pub, extra = []) => run('bash', [VERIFY, '--pubkey', pub, ...extra, tarballOf(ctx)]);

test('build-release.sh produces a signed release that verify-release.sh accepts', (t) => {
  const ctx = setup(t);
  const res = build(ctx);
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(fs.readdirSync(ctx.out).sort(), ['SHA256SUMS', 'SHA256SUMS.sig', `tunnelvault-v${ctx.version}.tar.gz`]);

  const sums = fs.readFileSync(path.join(ctx.out, 'SHA256SUMS'), 'utf8');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarballOf(ctx))).digest('hex');
  assert.equal(sums, `${digest}  tunnelvault-v${ctx.version}.tar.gz\n`);

  // Plain openssl (as documented for operators) agrees.
  const ossl = run('openssl', ['dgst', '-sha256', '-verify', ctx.keys.pub, '-signature',
    path.join(ctx.out, 'SHA256SUMS.sig'), path.join(ctx.out, 'SHA256SUMS')]);
  assert.equal(ossl.stdout.trim(), 'Verified OK');

  const v = verify(ctx);
  assert.equal(v.status, 0, v.out);
  assert.match(v.stdout, /^OK: tunnelvault-v2\.0\.1\.tar\.gz/);

  // Archive layout: everything under tunnelvault-vX.Y.Z/, VERSION + prebuilt frontend, no links.
  const list = mustRun('tar', ['-tvzf', tarballOf(ctx)]).stdout.trim().split('\n');
  for (const line of list) {
    assert.match(line, /^[-d]/, `only files/dirs expected: ${line}`);
    assert.match(line, / 0\/0 /, `root-owned entries expected: ${line}`);
    assert.match(line, / tunnelvault-v2\.0\.1\//);
  }
  const names = mustRun('tar', ['-tzf', tarballOf(ctx)]).stdout;
  assert.match(names, /^tunnelvault-v2\.0\.1\/frontend\/dist\/index\.html$/m);
  assert.match(names, /^tunnelvault-v2\.0\.1\/install-client\.sh$/m);
  // what install-server.sh / the dashboard's SetupGuide rely on (INTEGRATION B2)
  for (const f of ['VERSION', 'frontend/dist/index.html', 'backend/package-lock.json', 'gateway/gateway-helper.sh',
    'gateway/usermgr-worker.sh', 'gateway/tunnelvault-sudoers', 'install-server.sh', 'auto-update.sh']) {
    assert.ok(names.split('\n').includes(`tunnelvault-v2.0.1/${f}`), f);
  }
  const versionInArchive = mustRun('tar', ['-xzOf', tarballOf(ctx), 'tunnelvault-v2.0.1/VERSION']).stdout;
  assert.equal(versionInArchive, '2.0.1\n');
});

test('build-release.sh refuses trees the installers/updaters cannot use', (t) => {
  for (const [files, re] of [
    [{ 'gateway/usermgr-worker.sh': null }, /release tree lacks gateway\/usermgr-worker\.sh/],
    [{ 'backend/package-lock.json': null }, /release tree lacks backend\/package-lock\.json/],
    [{ 'auto-update.sh': '#!/bin/bash\nSOURCE_DIR="__SOURCE_DIR__"\ngit pull origin main\n' }, /auto-update\.sh is not the signed-release updater/],
    [{ 'auto-update.sh': '#!/bin/bash\n# >>> tv-updater-common\ngit pull origin main\n' }, /auto-update\.sh contains markers of the legacy git-pull updater/],
  ]) {
    const tmp = mkTmp(t);
    const keys = makeKey(path.join(tmp, 'key'));
    const repo = makeReleaseRepo(path.join(tmp, 'repo'), { version: '2.0.1', pubkey: keys.pub, files });
    const ctx = { repo, keys, version: '2.0.1', dist: makeFrontendDist(path.join(tmp, 'dist')), out: path.join(tmp, 'out') };
    const res = build(ctx);
    assert.notEqual(res.status, 0, JSON.stringify(files));
    assert.match(res.stderr, re);
    assert.ok(!fs.existsSync(tarballOf(ctx)), 'no tarball written');
  }
});

test('the real updaters carry no legacy git-updater markers', () => {
  for (const f of ['auto-update.sh', 'auto-update-client.sh']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.doesNotMatch(text, /^SOURCE_DIR=|git pull origin|__SOURCE_DIR__/m, f);
    assert.match(text, /^# >>> tv-updater-common\b/m, f);
  }
});

test('builds are reproducible (same commit -> identical tarball)', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  const first = fs.readFileSync(tarballOf(ctx));
  fs.rmSync(ctx.out, { recursive: true });
  assert.equal(build(ctx).status, 0);
  assert.ok(first.equals(fs.readFileSync(tarballOf(ctx))), 'tarball bytes differ between builds');
});

test('tampered tarball fails verification', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  const buf = fs.readFileSync(tarballOf(ctx));
  buf[buf.length - 20] ^= 0xff;
  fs.writeFileSync(tarballOf(ctx), buf);
  const v = verify(ctx);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /CHECKSUM MISMATCH/);
});

test('tampered SHA256SUMS fails verification (signature check comes first)', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  // Attacker replaces the tarball AND updates SHA256SUMS to match it.
  const evil = Buffer.from('evil tarball');
  fs.writeFileSync(tarballOf(ctx), evil);
  const digest = crypto.createHash('sha256').update(evil).digest('hex');
  fs.writeFileSync(path.join(ctx.out, 'SHA256SUMS'), `${digest}  tunnelvault-v${ctx.version}.tar.gz\n`);
  const v = verify(ctx);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /SIGNATURE VERIFICATION FAILED/);
});

test('signature from a different key fails verification', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  const other = makeKey(path.join(ctx.tmp, 'other-key'));
  const v = verify(ctx, other.pub);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /SIGNATURE VERIFICATION FAILED/);
});

test('corrupt / missing signature and bad public keys fail closed', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  const sig = path.join(ctx.out, 'SHA256SUMS.sig');
  const good = fs.readFileSync(sig);
  fs.writeFileSync(sig, good.subarray(0, good.length - 3));
  assert.equal(verify(ctx).status, 1);
  fs.rmSync(sig);
  assert.equal(verify(ctx).status, 1);
  fs.writeFileSync(sig, good);
  assert.equal(verify(ctx).status, 0);

  // Not a public key / missing key / RSA key.
  const junk = path.join(ctx.tmp, 'junk.pub');
  fs.writeFileSync(junk, 'not a key\n');
  assert.equal(verify(ctx, junk).status, 1);
  assert.equal(verify(ctx, path.join(ctx.tmp, 'missing.pub')).status, 1);
  const rsa = path.join(ctx.tmp, 'rsa.pub');
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(rsa, publicKey.export({ type: 'spki', format: 'pem' }));
  const r = verify(ctx, rsa);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not ECDSA P-256/);
});

test('SHA256SUMS must contain exactly one entry for the tarball', (t) => {
  const ctx = setup(t);
  assert.equal(build(ctx).status, 0);
  // Re-sign a SHA256SUMS with a duplicated (conflicting) line using the real key.
  const sums = path.join(ctx.out, 'SHA256SUMS');
  const line = fs.readFileSync(sums, 'utf8');
  fs.writeFileSync(sums, `${line}${'0'.repeat(64)}  tunnelvault-v${ctx.version}.tar.gz\n`);
  mustRun('openssl', ['dgst', '-sha256', '-sign', ctx.keys.key, '-out', path.join(ctx.out, 'SHA256SUMS.sig'), sums]);
  const v = verify(ctx);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /exactly one SHA256SUMS entry/);

  // A signed SHA256SUMS that does not list the tarball at all.
  fs.writeFileSync(sums, `${'a'.repeat(64)}  something-else.tar.gz\n`);
  mustRun('openssl', ['dgst', '-sha256', '-sign', ctx.keys.key, '-out', path.join(ctx.out, 'SHA256SUMS.sig'), sums]);
  assert.equal(verify(ctx).status, 1);
});

test('build-release.sh refuses a version that does not match the VERSION file', (t) => {
  const ctx = setup(t);
  ctx.version = '2.0.2';
  const res = build(ctx);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /VERSION file at HEAD says '2\.0\.1'/);
  assert.equal(fs.existsSync(path.join(ctx.out, 'tunnelvault-v2.0.2.tar.gz')), false);

  ctx.version = 'not-a-version';
  assert.notEqual(build(ctx).status, 0);
});

test('build-release.sh --require-tag and CI tag checks', (t) => {
  const ctx = setup(t);
  let res = build(ctx, ['--require-tag']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /tag v2\.0\.1 does not exist/);
  mustRun('git', ['tag', 'v2.0.1'], { cwd: ctx.repo });
  res = build(ctx, ['--require-tag']);
  assert.equal(res.status, 0, res.out);

  res = run('bash', [path.join(ctx.repo, 'scripts', 'release', 'build-release.sh'), ctx.version,
    '--frontend-dist', ctx.dist, '--out', ctx.out, '--unsigned'],
  { cwd: ctx.repo, env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /does not match VERSION/);
});

test('--unsigned + sign-release.sh (the CI split) and pinned-key mismatch', (t) => {
  const ctx = setup(t);
  const res = build(ctx, ['--unsigned']);
  assert.equal(res.status, 0, res.out);
  assert.equal(fs.existsSync(path.join(ctx.out, 'SHA256SUMS.sig')), false);
  assert.equal(verify(ctx).status, 1, 'unsigned release must not verify');

  const sign = path.join(ctx.repo, 'scripts', 'release', 'sign-release.sh');
  // A key that does not match the committed release-signing.pub is refused.
  const other = makeKey(path.join(ctx.tmp, 'other'));
  let s = run('bash', [sign, ctx.out, '--key', other.key], { cwd: ctx.repo });
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /does not match the pinned public key/);
  assert.equal(fs.existsSync(path.join(ctx.out, 'SHA256SUMS.sig')), false);

  // The key passed as PEM text in RELEASE_SIGNING_KEY (as in GitHub Actions).
  s = run('bash', [sign, ctx.out], {
    cwd: ctx.repo, env: { RELEASE_SIGNING_KEY: fs.readFileSync(ctx.keys.key, 'utf8') },
  });
  assert.equal(s.status, 0, s.out);
  assert.doesNotMatch(s.out, /BEGIN|PRIVATE/);
  assert.equal(verify(ctx).status, 0);

  // Missing key -> error, never an unsigned "success".
  s = run('bash', [sign, ctx.out], { cwd: ctx.repo, env: { RELEASE_SIGNING_KEY: '', RELEASE_SIGNING_KEY_FILE: '' } });
  assert.notEqual(s.status, 0);
});

test('sign-release.sh requires a pinned public key unless explicitly disabled', (t) => {
  const ctx = setup(t, { pinned: false });
  assert.equal(build(ctx, ['--unsigned']).status, 0);
  const sign = path.join(ctx.repo, 'scripts', 'release', 'sign-release.sh');
  let s = run('bash', [sign, ctx.out, '--key', ctx.keys.key], { cwd: ctx.repo });
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /pinned public key .* not found/);
  s = run('bash', [sign, ctx.out, '--key', ctx.keys.key, '--no-pinned-pubkey'], { cwd: ctx.repo });
  assert.equal(s.status, 0, s.out);
  assert.equal(verify(ctx).status, 0);
});

test('generate-signing-key.sh: P-256 pair, private key 0600, refuses overwrite and git work trees', (t) => {
  const tmp = mkTmp(t);
  const dir = path.join(tmp, 'k');
  const res = run('bash', [path.join(RELEASE_DIR, 'generate-signing-key.sh'), '--out', dir]);
  assert.equal(res.status, 0, res.out);
  assert.match(res.stdout, /RELEASE_SIGNING_KEY/);
  assert.match(res.stdout, /release-signing\.pub/);
  assert.doesNotMatch(res.stdout, /-----BEGIN/);
  assert.equal(fs.statSync(path.join(dir, 'release-signing.key')).mode & 0o777, 0o600);
  const text = mustRun('openssl', ['pkey', '-pubin', '-in', path.join(dir, 'release-signing.pub'), '-noout', '-text']).stdout;
  assert.match(text, /prime256v1|P-256/);

  const again = run('bash', [path.join(RELEASE_DIR, 'generate-signing-key.sh'), '--out', dir]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /refusing to overwrite/);

  const inRepo = run('bash', [path.join(RELEASE_DIR, 'generate-signing-key.sh'), '--out', path.join(REPO_ROOT, 'scripts', 'release', 'test', 'tmp-key-must-not-exist')]);
  assert.notEqual(inRepo.status, 0);
  assert.match(inRepo.stderr, /inside a git work tree/);
  fs.rmSync(path.join(REPO_ROOT, 'scripts', 'release', 'test', 'tmp-key-must-not-exist'), { recursive: true, force: true });

  // a work tree git itself would ignore (e.g. owned by another user under sudo) is still refused
  fs.mkdirSync(path.join(tmp, 'checkout', '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'checkout', 'sub'));
  const inCheckout = run('bash', [path.join(RELEASE_DIR, 'generate-signing-key.sh'), '--out', path.join(tmp, 'checkout', 'sub', 'keys')]);
  assert.notEqual(inCheckout.status, 0);
  assert.match(inCheckout.stderr, /inside a git work tree/);
  assert.ok(!fs.existsSync(path.join(tmp, 'checkout', 'sub', 'keys')));
});

test('updaters inline an identical copy of the verification code', () => {
  const lib = block(path.join(RELEASE_DIR, 'release-lib.sh'), '# >>> tv-verify', '# <<< tv-verify');
  for (const f of ['auto-update.sh', 'auto-update-client.sh']) {
    assert.equal(block(path.join(REPO_ROOT, f), '# >>> tv-verify', '# <<< tv-verify'), lib, `${f} verify block drifted`);
  }
  assert.equal(
    block(path.join(REPO_ROOT, 'auto-update.sh'), '# >>> tv-updater-common', '# <<< tv-updater-common'),
    block(path.join(REPO_ROOT, 'auto-update-client.sh'), '# >>> tv-updater-common', '# <<< tv-updater-common'),
    'server and client updater bodies drifted',
  );
});

test('VERSION file is a plain X.Y.Z', () => {
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8'), /^\d+\.\d+\.\d+\n$/);
});

test('shell scripts pass bash -n and shellcheck', (t) => {
  // every shell script of the project: installers, updaters, gateway helpers, release tooling
  const files = [
    ...fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith('.sh')),
    ...fs.readdirSync(path.join(REPO_ROOT, 'gateway')).filter((f) => f.endsWith('.sh')).map((f) => `gateway/${f}`),
    ...fs.readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.sh')).map((f) => `scripts/release/${f}`),
  ].map((f) => path.join(REPO_ROOT, f));
  for (const f of ['install-server.sh', 'install-client.sh', 'uninstall-server.sh', 'uninstall-client.sh',
    'auto-update.sh', 'auto-update-client.sh', 'gateway/usermgr-worker.sh', 'scripts/release/build-release.sh']) {
    assert.ok(files.includes(path.join(REPO_ROOT, f)), f);
  }
  for (const f of files) {
    const r = run('bash', ['-n', f]);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const sc = shellcheckBin();
  if (!sc) {
    t.skip('shellcheck not installed');
    return;
  }
  const r = run(sc, ['-x', '-P', REPO_ROOT, ...files], { cwd: REPO_ROOT });
  assert.equal(r.status, 0, r.out);
});
