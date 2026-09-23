'use strict';
// Shared helpers for the release-tooling / installer shell tests (node:test).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'scripts', 'release');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function mkTmp(t, prefix = 'tv-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Synchronous run — only for commands that do not talk to an in-process server. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, ...GIT_ENV, ...(opts.env || {}) },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr };
}

/** Asynchronous run (keeps the event loop free for in-process fake servers). */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      env: opts.cleanEnv ? opts.env : { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 60000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, out: stdout + stderr });
    });
  });
}

function mustRun(cmd, args, opts) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}):\n${res.out}`);
  }
  return res;
}

/** Throwaway ECDSA P-256 key pair via generate-signing-key.sh. */
function makeKey(dir) {
  mustRun('bash', [path.join(RELEASE_DIR, 'generate-signing-key.sh'), '--out', dir]);
  return { key: path.join(dir, 'release-signing.key'), pub: path.join(dir, 'release-signing.pub') };
}

/**
 * Temp git repo that looks like a TunnelVault checkout: the real scripts/release
 * tooling, a VERSION file, stub installers and optional extra files.
 */
function makeReleaseRepo(dir, { version, pubkey, files = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'scripts', 'release'), { recursive: true });
  for (const f of fs.readdirSync(RELEASE_DIR)) {
    const src = path.join(RELEASE_DIR, f);
    if (fs.statSync(src).isFile() && f.endsWith('.sh')) {
      fs.copyFileSync(src, path.join(dir, 'scripts', 'release', f));
      fs.chmodSync(path.join(dir, 'scripts', 'release', f), fs.statSync(src).mode & 0o777);
    }
  }
  fs.writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
  if (pubkey) fs.copyFileSync(pubkey, path.join(dir, 'release-signing.pub'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, { mode: 0o755 });
  }
  mustRun('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mustRun('git', ['add', '-A'], { cwd: dir });
  mustRun('git', ['commit', '-q', '-m', `release ${version}`], { cwd: dir });
  return dir;
}

function makeFrontendDist(dir) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>TunnelVault</title>\n');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("tv");\n');
  return dir;
}

/** Self-signed certificate for 127.0.0.1 / localhost. */
function makeCert(dir) {
  const key = path.join(dir, 'tls.key');
  const cert = path.join(dir, 'tls.crt');
  mustRun('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  return { key, cert };
}

/**
 * Fake GitHub: GET /api/latest -> {tag_name}; GET /download/<tag>/<asset> -> file
 * from releases[tag] (a directory). Records request paths.
 */
async function startReleaseServer({ tls, latest, releases }) {
  const state = { latest, releases, requests: [] };
  const handler = (req, res) => {
    state.requests.push(req.url);
    if (req.url === '/api/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof state.latest === 'string' ? { tag_name: state.latest } : state.latest));
      return;
    }
    const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(req.url);
    const dir = m && state.releases[m[1]];
    if (!dir || !/^[A-Za-z0-9._-]+$/.test(m[2]) || !fs.existsSync(path.join(dir, m[2]))) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(path.join(dir, m[2])).pipe(res);
  };
  const server = tls
    ? https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert) }, handler)
    : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  state.url = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  state.close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return state;
}

/** Extract the text between two marker lines (inclusive of neither). */
function block(file, begin, end) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const b = lines.findIndex((l) => l.startsWith(begin));
  const e = lines.findIndex((l, i) => i > b && l.startsWith(end));
  if (b < 0 || e < 0) throw new Error(`markers ${begin} / ${end} not found in ${file}`);
  return lines.slice(b + 1, e).join('\n');
}

/**
 * Minimal ustar writer so tests can craft hostile archives (.., absolute paths,
 * symlinks) that GNU tar would sanitize on creation.
 * entries: [{ name, type: 'file'|'dir'|'symlink'|'hardlink', content?, linkname? }]
 */
function craftTarGz(entries) {
  const zlib = require('node:zlib');
  const blocks = [];
  const typeFlag = { file: '0', hardlink: '1', symlink: '2', dir: '5' };
  for (const e of entries) {
    const content = Buffer.from(e.content || '');
    const h = Buffer.alloc(512, 0);
    const put = (str, off, len) => { Buffer.from(str).copy(h, off, 0, len); };
    const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
    if (Buffer.byteLength(e.name) > 100) throw new Error('name too long for test tar');
    put(e.name, 0, 100);
    put(oct(e.type === 'dir' ? 0o755 : 0o644, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(e.type === 'file' ? content.length : 0, 12), 124, 12);
    put(oct(1700000000, 12), 136, 12);
    put('        ', 148, 8);
    put(typeFlag[e.type], 156, 1);
    if (e.linkname) put(e.linkname, 157, 100);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h);
    if (e.type === 'file' && content.length) {
      blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Write tarball + SHA256SUMS + SHA256SUMS.sig (signed with keyFile) into dir. */
function writeSignedRelease(dir, tag, tarGz, keyFile) {
  const crypto = require('node:crypto');
  fs.mkdirSync(dir, { recursive: true });
  const name = `tunnelvault-${tag}.tar.gz`;
  fs.writeFileSync(path.join(dir, name), tarGz);
  const digest = crypto.createHash('sha256').update(tarGz).digest('hex');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${digest}  ${name}\n`);
  mustRun('openssl', ['dgst', '-sha256', '-sign', keyFile, '-out', path.join(dir, 'SHA256SUMS.sig'), path.join(dir, 'SHA256SUMS')]);
  return dir;
}

function shellcheckBin() {
  const candidates = [process.env.SHELLCHECK, 'shellcheck'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

module.exports = {
  REPO_ROOT,
  RELEASE_DIR,
  mkTmp,
  run,
  runAsync,
  mustRun,
  makeKey,
  makeReleaseRepo,
  makeFrontendDist,
  makeCert,
  startReleaseServer,
  block,
  craftTarGz,
  writeSignedRelease,
  shellcheckBin,
};
