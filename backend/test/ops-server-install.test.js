'use strict';

/**
 * Tests for the pure helpers of install-server.sh (sourced in bash; `main`
 * never runs) and for its argument validation. Nothing here touches the
 * system: every file lives in a temp directory.
 *
 * Optional external validators (skipped when unavailable):
 *   nginx            — TV_TEST_NGINX=/path/to/nginx or `nginx` on PATH
 *   sshd             — TV_TEST_SSHD=/path/to/sshd-wrapper (must be able to run `sshd -t`)
 *   systemd-analyze  — on PATH
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const INSTALLER = path.join(REPO, 'install-server.sh');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-ops-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run a bash snippet with install-server.sh sourced. Values are passed via env. */
function sh(script, env = {}) {
  const res = spawnSync('bash', ['-c', `source "$TV_INSTALLER"\n${script}`], {
    encoding: 'utf8',
    env: { ...process.env, TV_INSTALLER: INSTALLER, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function ok(script, env) {
  const r = sh(script, env);
  assert.equal(r.status, 0, `bash failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

function which(name, envVar) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  const r = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

test('sourcing the installer defines functions but does not run main', () => {
  const r = sh('declare -F main >/dev/null && declare -F env_set >/dev/null && echo sourced-ok');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'sourced-ok');
});

test('bash -n accepts every server-side script', () => {
  for (const f of ['install-server.sh', 'uninstall-server.sh', 'gateway/setup.sh', 'gateway/ssh_router.sh',
    'gateway/register_token.sh', 'gateway/manage-user.sh', 'gateway/gateway-helper.sh', 'gateway/usermgr-worker.sh']) {
    const r = spawnSync('bash', ['-n', path.join(REPO, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('argument validation rejects bad input before touching the system', () => {
  const cases = [
    [['--domain', 'bad domain'], /Invalid --domain/],
    [['--domain', 'evil.com;rm'], /Invalid --domain/],
    [['--port', '70000'], /Invalid --port/],
    [['--proxy-port', 'abc'], /Invalid --proxy-port/],
    [['--auth-token', 'short'], /--auth-token must be/],
    [['--auth-token', 'aaaaaaaaaaaaaaaa$(id)'], /--auth-token must be/],
    [['--wildcard-cert', '/etc/ssl/wild'], /--wildcard-cert requires --tls/],
    [['--tls', '--wildcard-cert', 'relative/dir'], /absolute path/],
    [['--tls', '--email', 'not-an-email'], /Invalid --email/],
    [['--email', 'ops@example.com'], /only used with --tls/],
    [['--domain'], /requires a value/],
    [['--bogus'], /Unknown option/],
  ];
  for (const [args, re] of cases) {
    const r = spawnSync('bash', [INSTALLER, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, `${args.join(' ')} should fail`);
    assert.match(r.stdout + r.stderr, re, args.join(' '));
  }
  const help = spawnSync('bash', [INSTALLER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const flag of ['--tls', '--email', '--wildcard-cert', '--no-firewall', '--yes', '--auto-update', '--release-pubkey', '--upgrade']) {
    assert.ok(help.stdout.includes(flag), `help mentions ${flag}`);
  }
});

test('validators', () => {
  const check = (fn, value) => sh(`${fn} "$V"`, { V: value }).status === 0;
  assert.ok(check('is_valid_domain', 'tunnel.example.com'));
  assert.ok(check('is_valid_domain', 'tunnel.local'));
  assert.ok(!check('is_valid_domain', 'localhost'));
  assert.ok(!check('is_valid_domain', '-bad.example.com'));
  assert.ok(!check('is_valid_domain', 'a..b'));
  assert.ok(!check('is_valid_domain', 'x.com/evil'));
  assert.ok(check('is_public_domain', 'tunnel.example.com'));
  assert.ok(!check('is_public_domain', 'tunnel.local'));
  assert.ok(!check('is_public_domain', '10.0.0.1'));
  assert.ok(check('is_valid_email', 'ops@example.com'));
  assert.ok(!check('is_valid_email', 'ops@localhost'));
  assert.ok(!check('is_valid_email', 'a b@example.com'));
  assert.ok(!check('is_valid_email', 'x@example.com;id'));
  assert.ok(check('is_valid_port', '1'));
  assert.ok(check('is_valid_port', '65535'));
  assert.ok(!check('is_valid_port', '0'));
  assert.ok(!check('is_valid_port', '65536'));
  assert.ok(!check('is_valid_port', '08'));
  assert.ok(check('is_valid_auth_token', 'a'.repeat(64)));
  assert.ok(!check('is_valid_auth_token', 'a'.repeat(15)));
  assert.ok(!check('is_valid_auth_token', `${'a'.repeat(20)} x`));
  assert.ok(check('is_safe_path', '/etc/letsencrypt/live/example.com-0001'));
  assert.ok(!check('is_safe_path', '/etc/../root'));
  assert.ok(!check('is_safe_path', '/etc/ssl/a b'));
  assert.ok(!check('is_safe_path', '/etc/ssl/x;y'));
  assert.ok(!check('is_safe_path', 'relative'));

  assert.equal(ok('version_major v22.3.0').trim(), '22');
  assert.equal(ok('version_major 18.19.1').trim(), '18');
  assert.ok(sh('version_ge 1.25.1 1.25.1').status === 0);
  assert.ok(sh('version_ge 1.26.0 1.25.1').status === 0);
  assert.ok(sh('version_ge 1.24.0 1.25.1').status !== 0);
  assert.ok(sh('version_ge 1.18.0 1.25.1').status !== 0);
  assert.ok(sh('version_ge 2 1.25.1').status === 0);
});

test('env_get / env_set / env_ensure keep other lines, owner and mode', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# comment',
    'PORT=4000',
    '# DOMAIN=commented.example.com',
    'export DOMAIN="tunnel.example.com"',
    "AUTH_TOKEN='abc'",
    'EMPTY=',
    'INLINE=value # note',
    'PORT=4000',
    'LAST=no-newline',
  ].join('\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const inode = fs.statSync(file).ino;
  const env = { F: file };

  assert.equal(ok('env_get "$F" DOMAIN', env).trim(), 'tunnel.example.com');
  assert.equal(ok('env_get "$F" AUTH_TOKEN', env).trim(), 'abc');
  assert.equal(ok('env_get "$F" EMPTY', env), '\n');
  assert.equal(ok('env_get "$F" INLINE', env).trim(), 'value', 'inline comments like dotenv');
  assert.equal(ok('env_get "$F" MISSING', env), '');
  assert.equal(sh('env_has "$F" EMPTY', env).status, 0);
  assert.notEqual(sh('env_has "$F" MISSING', env).status, 0);

  // values with characters that are special for sed/awk
  ok('env_set "$F" PUBLIC_URL "$V"', { ...env, V: 'https://x.example.com/a&b\\c|d' });
  assert.equal(ok('env_get "$F" PUBLIC_URL', env).trim(), 'https://x.example.com/a&b\\c|d');
  ok('env_set "$F" PORT 4100', env);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^PORT=/gm).length, 1, 'duplicates collapsed');
  assert.match(text, /^PORT=4100$/m);
  assert.match(text, /^# DOMAIN=commented\.example\.com$/m, 'comments untouched');
  assert.match(text, /^LAST=no-newline$/m, 'last line kept');
  assert.equal(fs.statSync(file).ino, inode, 'rewritten in place');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'mode kept');

  // env_ensure only appends missing keys
  assert.equal(sh('env_ensure "$F" PORT 1', env).status, 1);
  assert.equal(sh('env_ensure "$F" GEOIP_PROVIDER off "GeoIP provider"', env).status, 0);
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /# GeoIP provider\nGEOIP_PROVIDER=off\n$/);
  assert.match(after, /^PORT=4100$/m);

  // refuses multi-line values and bad keys
  assert.notEqual(sh('env_set "$F" X "$V"', { ...env, V: 'a\nINJECTED=1' }).status, 0);
  assert.notEqual(sh('env_set "$F" "bad key" 1', env).status, 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /INJECTED/);
});

test('env_disable_letsencrypt_tls comments out only /etc/letsencrypt TLS paths', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    'PORT=4000',
    'TLS_CERT=/etc/letsencrypt/live/example.com/fullchain.pem',
    'TLS_KEY="/etc/letsencrypt/live/example.com/privkey.pem"',
    "export TLS_PROXY_CERT='/etc/letsencrypt/live/example.com/fullchain.pem'",
    'TLS_PROXY_KEY=/opt/tunnelvault/certs/key.pem',
    '# TLS_CERT=/path/to/fullchain.pem',
    '',
  ].join('\n'));
  const n = ok('env_disable_letsencrypt_tls "$F"', { F: file }).trim();
  assert.equal(n, '3');
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /^(export )?TLS_(PROXY_)?(CERT|KEY)=["']?\/etc\/letsencrypt/m);
  assert.match(text, /^# Disabled by install-server\.sh.*TLS_CERT=\/etc\/letsencrypt/m);
  assert.match(text, /^TLS_PROXY_KEY=\/opt\/tunnelvault\/certs\/key\.pem$/m, 'other paths untouched');
  assert.equal(ok('env_disable_letsencrypt_tls "$F"', { F: file }).trim(), '0', 'idempotent');
});

test('fresh .env: secrets, spool dir, privacy defaults, TLS settings, parseable by dotenv', () => {
  const dotenv = require('dotenv');
  const base = 'API_PORT=4000; PROXY_PORT=4001; DOMAIN=tunnel.example.com; AUTH_TOKEN=$(random_hex 32); ';

  const plain = dotenv.parse(ok(`${base} TLS_MODE=none; render_env_file "$(random_hex 32)"`));
  assert.match(plain.AUTH_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(plain.DATA_ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.equal(plain.USERMGR_SPOOL_DIR, '/opt/tunnelvault/data/usermgr');
  assert.equal(plain.GEOIP_PROVIDER, 'off');
  assert.equal(plain.SESSION_RETENTION_DAYS, '90');
  assert.equal(plain.NODE_ENV, 'production');
  assert.equal(plain.DB_PATH, '/opt/tunnelvault/data/tunnelvault.db');
  assert.equal(plain.BIND_HOST, '0.0.0.0');
  assert.equal(plain.TRUST_PROXY, undefined);
  assert.equal(plain.TLS_CERT, undefined);

  const tls = dotenv.parse(ok(`${base} TLS_MODE=new; WILDCARD_DIR=; render_env_file "$(random_hex 32)"`));
  assert.equal(tls.BIND_HOST, '127.0.0.1');
  assert.equal(tls.TRUST_PROXY, 'loopback');
  assert.equal(tls.PUBLIC_URL, 'https://tunnel.example.com');
  assert.equal(tls.HTTP_TUNNEL_URL_TEMPLATE, 'http://{subdomain}.tunnel.example.com');
  assert.equal(tls.TLS_CERT, undefined);
  assert.equal(tls.TLS_KEY, undefined);

  const wild = dotenv.parse(ok(`${base} TLS_MODE=new; WILDCARD_DIR=/etc/ssl/wild; render_env_file x`));
  assert.equal(wild.HTTP_TUNNEL_URL_TEMPLATE, 'https://{subdomain}.tunnel.example.com');
});

test('systemd units: hardening, restart policy, usermgr path unit, updater timer', (t) => {
  const svc = ok('render_service_unit /usr/bin/node');
  for (const line of ['UMask=0077', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
    'RestartPreventExitStatus=78', 'ReadWritePaths=/opt/tunnelvault/data /opt/tunnelvault/logs',
    'EnvironmentFile=/opt/tunnelvault/backend/.env', 'User=tunnelvault', 'CapabilityBoundingSet=']) {
    assert.ok(svc.split('\n').includes(line), `service unit has ${line}`);
  }
  assert.doesNotMatch(svc, /MemoryDenyWriteExecute/, 'V8 needs W+X memory');

  const pathUnit = ok('render_usermgr_path_unit');
  assert.match(pathUnit, /^PathExistsGlob=\/opt\/tunnelvault\/data\/usermgr\/\*\.req$/m);
  assert.match(pathUnit, /^Unit=tunnelvault-usermgr\.service$/m);
  const worker = ok('render_usermgr_service_unit');
  assert.match(worker, /^ExecStart=\/opt\/tunnelvault\/usermgr-worker\.sh$/m);
  assert.match(worker, /^User=root$/m);
  assert.doesNotMatch(worker, /^EnvironmentFile=/m, 'never reads the service-writable .env');

  const timer = ok('render_updater_timer_unit 12h');
  for (const line of ['OnBootSec=15min', 'OnUnitActiveSec=12h', 'RandomizedDelaySec=1h', 'Persistent=true']) {
    assert.ok(timer.split('\n').includes(line), `timer has ${line}`);
  }
  assert.doesNotMatch(timer, /Requires=/, 'enabling the timer must not start an update immediately');
  assert.match(ok('render_updater_timer_unit 6h'), /^OnUnitActiveSec=6h$/m);
  assert.match(ok('render_updater_timer_unit "1h;ExecStart=/bin/sh"'), /^OnUnitActiveSec=12h$/m, 'invalid schedule falls back');
  const updSvc = ok('render_updater_service_unit');
  assert.match(updSvc, /^Type=oneshot$/m);
  assert.match(updSvc, /^User=root$/m);
  assert.match(updSvc, /^ExecStart=\/opt\/tunnelvault\/auto-update\.sh$/m);

  const conf = ok('render_update_conf 1');
  for (const line of ['ENABLED=1', 'SCHEDULE=12h', 'UPDATE_REPO=TrainABit/ssh-tunnel', 'PINNED_VERSION=',
    'PUBKEY=/etc/tunnelvault/release-signing.pub']) {
    assert.ok(conf.split('\n').includes(line), `update.conf has ${line}`);
  }

  const analyze = which('systemd-analyze');
  if (!analyze) return t.diagnostic('systemd-analyze not available — syntax check skipped');
  const dir = tmpDir(t);
  const inst = path.join(dir, 'opt');
  fs.mkdirSync(path.join(inst, 'backend'), { recursive: true });
  for (const f of ['usermgr-worker.sh', 'auto-update.sh']) {
    fs.writeFileSync(path.join(inst, f), '#!/bin/sh\n', { mode: 0o755 });
  }
  const units = ok(`INSTALL_DIR="$I"; DATA_DIR="$I/data"; LOG_DIR="$I/logs"; USERMGR_SPOOL_DIR="$I/data/usermgr";
    ENV_FILE="$I/backend/.env"; UPDATER_SCRIPT="$I/auto-update.sh"; cd "$D"
    render_service_unit "$NODE" > tunnelvault.service
    render_usermgr_path_unit > tunnelvault-usermgr.path
    render_usermgr_service_unit > tunnelvault-usermgr.service
    render_updater_service_unit > tunnelvault-autoupdate.service
    render_updater_timer_unit 12h > tunnelvault-autoupdate.timer
    ls`, { I: inst, D: dir, NODE: process.execPath });
  assert.match(units, /tunnelvault\.service/);
  const r = spawnSync(analyze, ['verify', '--man=no', ...['tunnelvault.service', 'tunnelvault-usermgr.path',
    'tunnelvault-usermgr.service', 'tunnelvault-autoupdate.service', 'tunnelvault-autoupdate.timer']
    .map((u) => path.join(dir, u))], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `systemd-analyze verify: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Unknown (key|section)|Invalid|Failed to parse/i);
});

test('sshd block: idempotent, replaces the v1 block, terminates with Match all', (t) => {
  const dir = tmpDir(t);
  const cfg = path.join(dir, 'sshd_config');
  fs.writeFileSync(cfg, [
    'Include /etc/ssh/sshd_config.d/*.conf',
    'PasswordAuthentication no',
    'Match User admin',
    '    X11Forwarding yes',
    '',
    '# === TUNNELVAULT-GATEWAY START ===',
    'AllowTcpForwarding yes',
    'GatewayPorts no',
    '',
    'Match User "gw-*"',
    '    ForceCommand /opt/tunnelvault/ssh_router.sh',
    '# === TUNNELVAULT-GATEWAY END ===',
    '',
  ].join('\n'));
  const once = ok('sshd_config_with_block "$F"', { F: cfg });
  fs.writeFileSync(cfg, once);
  const twice = ok('sshd_config_with_block "$F"', { F: cfg });
  assert.equal(twice, once, 'idempotent');
  assert.equal(once.match(/TUNNELVAULT-GATEWAY START/g).length, 1);
  assert.doesNotMatch(once, /^AllowTcpForwarding yes$/m, 'no global forwarding change any more');
  assert.match(once, /Match User "gw-\*"\n {4}ForceCommand \/opt\/tunnelvault\/ssh_router\.sh\n/);
  assert.match(once, /^ {4}AuthenticationMethods publickey$/m);
  assert.match(once, /^ {4}PermitTTY no$/m);
  assert.match(once, /^Match all\n# === TUNNELVAULT-GATEWAY END ===\n$/m);
  assert.match(once, /^Match User admin\n {4}X11Forwarding yes\n\n# === TUNNELVAULT-GATEWAY START/m);

  const sshd = process.env.TV_TEST_SSHD;
  if (!sshd) return t.diagnostic('TV_TEST_SSHD not set — sshd -t skipped');
  const hostKey = path.join(dir, 'hostkey');
  spawnSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', hostKey]);
  fs.chmodSync(hostKey, 0o600);
  const plain = path.join(dir, 'plain_config');
  fs.writeFileSync(plain, 'UsePAM no\nPasswordAuthentication no\n');
  fs.writeFileSync(plain, ok('sshd_config_with_block "$F"', { F: plain }));
  const r = spawnSync(sshd, ['-t', '-f', plain, '-h', hostKey], { encoding: 'utf8' });
  assert.equal(r.status, 0, `sshd -t: ${r.stderr}`);
  const gw = spawnSync(sshd, ['-T', '-f', plain, '-h', hostKey, '-C', 'user=gw-abc,host=h,addr=192.0.2.1'], { encoding: 'utf8' });
  assert.match(gw.stdout, /^forcecommand \/opt\/tunnelvault\/ssh_router\.sh$/m);
  assert.match(gw.stdout, /^allowtcpforwarding no$/m);
  const other = spawnSync(sshd, ['-T', '-f', plain, '-h', hostKey, '-C', 'user=alice,host=h,addr=192.0.2.1'], { encoding: 'utf8' });
  assert.match(other.stdout, /^forcecommand none$/m, 'other users are not affected');
});

function renderNginx(mode, { wildcard = '', ipv6 = 1, h2 = 0, leDir, acme, logDir, apiPort = 4000 } = {}) {
  return ok(`LE_LIVE_DIR="$LE"; ACME_WEBROOT="$ACME"; NGINX_LOG_DIR="$LOGS"
    render_nginx_conf "$MODE" tunnel.example.com "$API" 4001 "$W" "$V6" "$H2"`,
  { LE: leDir || '/etc/letsencrypt/live', ACME: acme || '/var/www/tunnelvault-acme', LOGS: logDir || '/var/log/nginx',
    MODE: mode, W: wildcard, V6: String(ipv6), H2: String(h2), API: String(apiPort) });
}

/** Move the listeners of a rendered site to unprivileged ports (nginx -t binds them). */
function onPorts(conf, httpPort, httpsPort) {
  return conf.replace(/listen (\[::\]:)?80\b/g, `listen $1${httpPort}`).replace(/listen (\[::\]:)?443\b/g, `listen $1${httpsPort}`);
}

/** Main nginx.conf for a throwaway prefix: distro-like default access_log in http {}. */
function nginxMain(dir, site) {
  const temps = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']
    .map((k) => `    ${k}_temp_path ${dir}/${k}_temp;`).join('\n');
  return `pid ${dir}/nginx.pid;\nerror_log ${dir}/main-error.log;\nevents {}\nhttp {\n${temps}\n`
    + `    access_log ${dir}/distro-access.log;\n    include ${site};\n}\n`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function mkCert(le, sub, cn) {
  const d = path.join(le, sub);
  fs.mkdirSync(d, { recursive: true });
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '1', '-subj', `/CN=${cn}`, '-keyout', path.join(d, 'privkey.pem'), '-out', path.join(d, 'fullchain.pem')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return d;
}

test('nginx configuration: websockets, /ws + /ws/ssh, wildcard block, ACME webroot', () => {
  const https = renderNginx('https');
  assert.match(https, /^# Managed by TunnelVault install-server\.sh/);
  assert.match(https, /map \$http_upgrade \$tunnelvault_connection_upgrade \{\n {4}default upgrade;\n {4}''\s+close;\n\}/);
  assert.match(https, /location \^~ \/ws\/ssh \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:4000;[^}]*proxy_buffering off;/);
  assert.match(https, /location \^~ \/ws \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:4000;/);
  assert.match(https, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(https, /proxy_set_header Connection \$tunnelvault_connection_upgrade;/);
  assert.match(https, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(https, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  // the backend's same-origin (Origin vs Host / X-Forwarded-Host) and __Host- cookie checks
  assert.match(https, /proxy_set_header Host \$host;/);
  assert.match(https, /proxy_set_header X-Forwarded-Host \$host;/);
  // HSTS comes from the backend (no includeSubDomains: *.DOMAIN tunnels may be plain HTTP)
  assert.doesNotMatch(https, /Strict-Transport-Security|includeSubDomains/i);
  assert.match(https, /location \^~ \/\.well-known\/acme-challenge\/ \{\n {8}root \/var\/www\/tunnelvault-acme;/);
  assert.match(https, /ssl_certificate {5}\/etc\/letsencrypt\/live\/tunnel\.example\.com\/fullchain\.pem;/);
  assert.match(https, /listen 443 ssl http2;/);
  assert.match(https, /listen \[::\]:443 ssl http2;/);
  assert.match(https, /server_name \*\.tunnel\.example\.com;[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4001;[\s\S]*proxy_buffering off;/);
  assert.match(https, /client_max_body_size 100m;/);
  assert.match(https, /# tunnelvault-wildcard-cert: none/);
  // no header set inside a location (it would drop the inherited ones)
  for (const block of https.split('location ').slice(1)) {
    assert.doesNotMatch(block.split('}')[0], /proxy_set_header/, 'no proxy_set_header inside locations');
  }
  // without a wildcard cert, *.DOMAIN is plain HTTP on port 80 (never an apex-only cert on 443)
  const wildBlock = https.slice(https.indexOf('server_name *.tunnel.example.com'));
  assert.doesNotMatch(wildBlock, /ssl_certificate/);

  const wild = renderNginx('https', { wildcard: '/etc/letsencrypt/live/wild', ipv6: 0, h2: 1 });
  assert.match(wild, /# tunnelvault-wildcard-cert: \/etc\/letsencrypt\/live\/wild/);
  assert.match(wild, /server_name \*\.tunnel\.example\.com;\n {4}server_tokens off;\n {4}location \/ \{\n {8}return 301 https/);
  assert.match(wild, /ssl_certificate {5}\/etc\/letsencrypt\/live\/wild\/fullchain\.pem;/);
  assert.match(wild, /http2 on;/);
  assert.doesNotMatch(wild, /Strict-Transport-Security|includeSubDomains/i);
  assert.doesNotMatch(wild, /listen \[::\]/);
  assert.doesNotMatch(wild, /ssl http2/);

  const acme = renderNginx('acme');
  assert.match(acme, /acme-challenge/);
  assert.doesNotMatch(acme, /ssl_certificate|listen 443/);

  // helpers used on upgrade
  assert.equal(ok('F=$(mktemp); render_nginx_conf https a.example.com 1 2 /x/y 0 0 > "$F"; nginx_conf_is_ours "$F" && nginx_conf_wildcard_dir "$F"; rm -f "$F"').trim(), '/x/y');
  assert.equal(ok('F=$(mktemp); printf "# TunnelVault — auto-generated by install-server.sh\\nserver {}\\n" > "$F"; nginx_conf_is_ours "$F" && echo v1; rm -f "$F"').trim(), 'v1');
  assert.notEqual(sh('F=$(mktemp); printf "server {}\\n" > "$F"; nginx_conf_is_ours "$F"; rc=$?; rm -f "$F"; exit $rc').status, 0);
});

function nginxH2(nginx) {
  const version = (spawnSync(nginx, ['-v'], { encoding: 'utf8' }).stderr.match(/nginx\/([0-9.]+)/) || [])[1] || '0';
  return sh(`version_ge "${version}" 1.25.1`).status === 0 ? 1 : 0;
}

test('nginx -t accepts the generated configurations', async (t) => {
  const nginx = which('nginx', 'TV_TEST_NGINX');
  if (!nginx) return t.diagnostic('nginx not available — nginx -t skipped');
  const h2 = nginxH2(nginx);
  const dir = tmpDir(t);
  const le = path.join(dir, 'live');
  const acme = path.join(dir, 'acme');
  fs.mkdirSync(acme);
  mkCert(le, 'tunnel.example.com', 'tunnel.example.com');
  const wildDir = mkCert(le, 'wild', '*.tunnel.example.com');
  // like the installer: IPv6 listeners only when the kernel has IPv6
  const ipv6 = fs.existsSync('/proc/net/if_inet6') ? 1 : 0;
  const o = { leDir: le, acme, logDir: dir };
  const variants = {
    acme: renderNginx('acme', { ...o, h2, ipv6 }),
    https: renderNginx('https', { ...o, h2, ipv6 }),
    httpsNoV6: renderNginx('https', { ...o, h2, ipv6: 0 }),
    httpsOtherH2: renderNginx('https', { ...o, h2: h2 ? 0 : 1, ipv6 }),
    wildcard: renderNginx('https', { ...o, h2, ipv6, wildcard: wildDir }),
    wildcardNoV6: renderNginx('https', { ...o, h2, wildcard: wildDir, ipv6: 0 }),
  };
  if (!h2) delete variants.httpsOtherH2; // "http2 on;" needs nginx >= 1.25.1
  // nginx -t binds the listeners: use unprivileged ports so this also runs as non-root
  const [p80, p443] = [await freePort(), await freePort()];
  for (const [name, conf] of Object.entries(variants)) {
    const site = path.join(dir, `${name}.conf`);
    fs.writeFileSync(site, onPorts(conf, p80, p443));
    const main = path.join(dir, `${name}-nginx.conf`);
    fs.writeFileSync(main, nginxMain(dir, site));
    const r = spawnSync(nginx, ['-t', '-q', '-p', dir, '-e', path.join(dir, 'error.log'), '-c', main], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test('nginx never logs device tokens from /api/tokens/<token> URLs (F8)', async (t) => {
  const nginx = which('nginx', 'TV_TEST_NGINX');
  if (!nginx) return t.diagnostic('nginx not available — log redaction check skipped');
  const http = require('http');
  const https = require('https');
  const dir = tmpDir(t);
  const le = path.join(dir, 'live');
  const acme = path.join(dir, 'acme');
  fs.mkdirSync(acme);
  mkCert(le, 'tunnel.example.com', 'tunnel.example.com');

  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('{}'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const apiPort = upstream.address().port;
  const [p80, p443] = [await freePort(), await freePort()];
  const site = path.join(dir, 'site.conf');
  fs.writeFileSync(site, onPorts(renderNginx('https', { leDir: le, acme, logDir: dir, ipv6: 0, h2: nginxH2(nginx), apiPort }), p80, p443));
  const main = path.join(dir, 'nginx.conf');
  fs.writeFileSync(main, nginxMain(dir, site).replace('events {}', 'daemon off;\nevents {}'));
  const proc = require('child_process').spawn(nginx, ['-p', dir, '-e', path.join(dir, 'main-error.log'), '-c', main],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  t.after(() => proc.kill('SIGQUIT'));

  const request = (method, urlPath, { port = p443, tls = true } = {}) => new Promise((resolve, reject) => {
    const mod = tls ? https : http;
    const req = mod.request({ host: '127.0.0.1', port, method, path: urlPath, servername: 'tunnel.example.com',
      headers: { Host: 'tunnel.example.com', 'Content-Type': 'application/json' }, rejectUnauthorized: false, agent: false },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(method === 'PATCH' ? '{"active":0}' : undefined);
  });
  // wait until nginx listens
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { await request('GET', '/'); up = true; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(up, `nginx did not start: ${stderr}`);

  const SECRET = 'SecretTok123';
  assert.equal(await request('GET', `/api/tokens/${SECRET}`), 200);
  assert.equal(await request('PATCH', `/api/tokens/${SECRET}`), 200);
  assert.equal(await request('DELETE', `/API/Tokens/${SECRET}/sessions?x=1`), 200);
  assert.equal(await request('GET', '/api/sessions?ticket=TicketSecret9'), 200);
  assert.equal(await request('GET', `/api/tokens/${SECRET}`, { port: p80, tls: false }), 301);
  assert.ok(seen.includes(`PATCH /api/tokens/${SECRET}`), 'requests reach the backend unchanged');
  // upstream down -> 502; nginx's error.log would carry the request line
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal(await request('GET', `/api/tokens/${SECRET}`), 502);

  // nginx writes the access log synchronously per request; give it a moment anyway
  await new Promise((r) => setTimeout(r, 200));
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const access = read('access.log');
  assert.match(access, /"GET \/api\/tokens\/\[redacted\] HTTP\/[0-9.]+" 200/);
  assert.match(access, /"PATCH \/api\/tokens\/\[redacted\] HTTP\/[0-9.]+" 200/);
  assert.match(access, /"DELETE \/api\/tokens\/\[redacted\]\/sessions HTTP/);
  assert.match(access, /"GET \/api\/sessions\?\[redacted\] HTTP/);
  assert.match(access, /"GET \/api\/tokens\/\[redacted\] HTTP\/1\.1" 301/, 'port 80 redirect block too');
  for (const f of ['access.log', 'error.log', 'distro-access.log', 'main-error.log']) {
    assert.doesNotMatch(read(f), new RegExp(`${SECRET}|TicketSecret9`, 'i'), `${f} must not contain secrets`);
  }
  assert.equal(read('distro-access.log'), '', 'the distro default access_log is overridden');
});

/**
 * A throwaway install tree for preflight + prepare_data_dirs. Every chown the
 * installer runs is recorded (and, as root, really executed: the service user is
 * "daemon", a system user with a same-named group, and owns DATA_DIR and .env like
 * on a real server). Unprivileged, the service user is the test user, the root
 * check of preflight is patched out and only the recorded chown calls are checked.
 */
const IS_ROOT = Boolean(process.getuid && process.getuid() === 0);
const HAS_DAEMON = spawnSync('id', ['-u', 'daemon']).status === 0 && spawnSync('getent', ['group', 'daemon']).status === 0;
const AS_ROOT = IS_ROOT && HAS_DAEMON;

function dataDirRoot(t) {
  const T = tmpDir(t);
  fs.chmodSync(T, 0o755);
  const I = path.join(T, 'opt');
  const D = path.join(I, 'data');
  fs.mkdirSync(path.join(I, 'backend'), { recursive: true });
  fs.mkdirSync(D, { mode: 0o700 });
  fs.mkdirSync(path.join(T, 'etc'));
  fs.mkdirSync(path.join(T, 'nginx'));
  const secret = path.join(T, 'etc', 'shadow-like');
  fs.writeFileSync(secret, 'root-secret\n', { mode: 0o600 });
  const user = AS_ROOT ? 'daemon' : os.userInfo().username;
  const uid = AS_ROOT ? Number(spawnSync('id', ['-u', 'daemon'], { encoding: 'utf8' }).stdout.trim()) : os.userInfo().uid;
  const gid = AS_ROOT ? Number(spawnSync('id', ['-g', 'daemon'], { encoding: 'utf8' }).stdout.trim()) : os.userInfo().gid;
  if (AS_ROOT) fs.chownSync(D, uid, gid);
  let installer = INSTALLER;
  if (!IS_ROOT) {
    installer = path.join(T, 'install-server.sh');
    const rootCheck = /^ {4}\[\[ \$EUID -eq 0 \]\] \|\| fail "This script must be run as root.*$/m;
    const text = fs.readFileSync(INSTALLER, 'utf8');
    assert.match(text, rootCheck);
    fs.writeFileSync(installer, text.replace(rootCheck, '    : # root check disabled for the test'));
  }
  const chownLog = path.join(T, 'chown.log');
  const writeEnv = (lines) => {
    const envFile = path.join(I, 'backend', '.env');
    fs.writeFileSync(envFile, `${['AUTH_TOKEN=abcdefabcdefabcdef', ...lines].join('\n')}\n`, { mode: 0o600 });
    if (AS_ROOT) fs.chownSync(envFile, uid, gid);
  };
  const prelude = `
    chown() { printf '%s\\n' "$*" >> "$CHOWN_LOG"; if (( EUID == 0 )); then command chown "$@"; fi; }
    apt-get() { :; }; systemctl() { :; }
    INSTALL_DIR="$I"; DATA_DIR="$I/data"; LOG_DIR="$I/logs"
    USERMGR_SPOOL_DIR="$DATA_DIR/usermgr"; DEFAULT_DB_PATH="$DATA_DIR/tunnelvault.db"; DB_PATH="$DEFAULT_DB_PATH"
    ENV_FILE="$I/backend/.env"; SERVICE_USER="$SVC"; NGINX_DIR="$T/nginx"; SCRIPT_DIR="$REPO"`;
  const bash = (script, env = {}) => {
    const res = spawnSync('bash', ['-c', `source "$TV_INSTALLER"\n${prelude}\n${script}`], {
      encoding: 'utf8',
      env: { ...process.env, TV_INSTALLER: installer, I, T, REPO, SVC: user, CHOWN_LOG: chownLog, ...env },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const run = () => bash(`UPGRADE=true; ASSUME_YES=true
    preflight >&2
    echo "DB_PATH=$DB_PATH"
    prepare_data_dirs >&2`);
  const chowns = () => (fs.existsSync(chownLog) ? fs.readFileSync(chownLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { T, I, D, secret, uid, gid, user, run, bash, writeEnv, chowns };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('prepare_data_dirs never chowns through a symlinked directory in DB_PATH (F7)', (t) => {
  if (!AS_ROOT) t.diagnostic('not root: checking the recorded chown calls only');
  let env = dataDirRoot(t);
  const { D, secret, uid, gid } = env;
  // the service user plants DATA_DIR/x -> <tmp>/etc and points DB_PATH through it
  const link = path.join(D, 'x');
  fs.symlinkSync(path.join(env.T, 'etc'), link);
  if (AS_ROOT) fs.lchownSync(link, uid, gid);
  env.writeEnv([`DB_PATH=${link}/shadow-like`]);
  const r = env.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`^DB_PATH=${escapeRe(D)}/tunnelvault\\.db$`, 'm'), 'falls back to DEFAULT_DB_PATH');
  assert.match(r.stdout + r.stderr, /not a file directly inside/);
  const calls = env.chowns();
  assert.ok(calls.some((c) => c.endsWith(` ${D}`)), `DATA_DIR is still handed to the service user: ${calls}`);
  assert.ok(!calls.some((c) => c.includes('shadow-like') || c.includes(`${D}/x`)), `no chown through the link: ${calls}`);
  for (const c of calls) assert.match(c, /^-h -- /, 'chown never dereferences');
  if (AS_ROOT) {
    const st = fs.statSync(secret);
    assert.equal(st.uid, 0, 'the target file stays root-owned');
    assert.equal(st.gid, 0);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fs.statSync(D).uid, uid);
  }

  // a plain file name directly in DATA_DIR is still accepted
  env = dataDirRoot(t);
  const custom = path.join(env.D, 'custom.db');
  env.writeEnv([`DB_PATH=${custom}`]);
  fs.writeFileSync(custom, '');
  const ok2 = env.run();
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.ok(ok2.stdout.includes(`DB_PATH=${custom}\n`), ok2.stdout);
  assert.ok(env.chowns().some((c) => c.endsWith(` ${custom}`)), 'the real database file is chowned');
  if (AS_ROOT) assert.equal(fs.statSync(custom).uid, env.uid);
  // subdirectories, dot names and paths outside DATA_DIR fall back as well
  fs.symlinkSync(path.join(env.T, 'etc'), path.join(env.D, 'lnk'));
  for (const bad of [path.join(env.D, 'sub', 'a.db'), path.join(env.D, '.'), `${env.D}x/a.db`, '/etc/shadow',
    `${env.D}/lnk/`, `${env.D}//lnk`, `${env.D}/./lnk`]) {
    env.writeEnv([`DB_PATH=${bad}`]);
    const rb = env.run();
    assert.equal(rb.status, 0, rb.stderr);
    assert.match(rb.stdout, new RegExp(`^DB_PATH=${escapeRe(env.D)}/tunnelvault\\.db$`, 'm'), bad);
  }
  assert.ok(!env.chowns().some((c) => c.includes('lnk')), `never through the link: ${env.chowns()}`);
  if (AS_ROOT) assert.equal(fs.statSync(path.join(env.T, 'etc')).uid, 0);
});

test('safe_chown leaves symlinked DB side files, symlinked parents and their targets alone (F7)', (t) => {
  const env = dataDirRoot(t);
  const wal = path.join(env.D, 'tunnelvault.db-wal');
  fs.symlinkSync(env.secret, wal);
  const r = env.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!env.chowns().some((c) => c.includes('-wal') || c.includes('shadow-like')), String(env.chowns()));
  if (AS_ROOT) {
    assert.equal(fs.lstatSync(wal).uid, 0, 'the link itself is untouched');
    assert.equal(fs.statSync(env.secret).uid, 0, 'the link target stays root-owned');
  }

  // a symlinked directory component below INSTALL_DIR is refused
  const sub = path.join(env.D, 'sub');
  fs.symlinkSync(path.join(env.T, 'etc'), sub);
  const res = env.bash('safe_chown "$SVC:$SVC" "$F"; echo rc=$?', { F: path.join(sub, 'shadow-like') });
  assert.match(res.stdout, /rc=0/);
  assert.match(res.stdout + res.stderr, /contains a symlink/);
  assert.ok(!env.chowns().some((c) => c.includes('shadow-like')));
  // "link/" with a trailing slash (or other unnormalised forms) would dereference the link
  for (const f of [`${sub}/`, `${env.D}//sub`, `${env.D}/./sub`]) {
    const rr = env.bash('safe_chown "$SVC:$SVC" "$F"; echo rc=$?', { F: f });
    assert.match(rr.stdout, /rc=0/, f);
  }
  const trailing = env.bash('safe_chown "$SVC:$SVC" "$F"', { F: `${sub}/` });
  assert.match(trailing.stdout + trailing.stderr, /not a normalised path/);
  assert.ok(!env.chowns().some((c) => c.includes('sub')), String(env.chowns()));
  if (AS_ROOT) assert.equal(fs.statSync(path.join(env.T, 'etc')).uid, 0, 'the link target directory stays root-owned');
  if (AS_ROOT) assert.equal(fs.statSync(env.secret).uid, 0);

  // above INSTALL_DIR a symlink is root's own choice and still works
  const alias = path.join(env.T, 'alias');
  fs.symlinkSync(env.T, alias);
  const plain = path.join(env.D, 'plain');
  fs.writeFileSync(plain, '');
  const viaAlias = path.join(alias, 'opt', 'data', 'plain');
  const res2 = env.bash('INSTALL_DIR="$ALIAS_I"; safe_chown "$SVC" "$F"', { ALIAS_I: path.join(alias, 'opt'), F: viaAlias });
  assert.equal(res2.status, 0, res2.stderr);
  assert.ok(env.chowns().includes(`-h -- ${env.user} ${viaAlias}`), String(env.chowns()));
  if (AS_ROOT) assert.equal(fs.statSync(plain).uid, env.uid);
});

test('write_file replaces atomically (new inode) and reports unchanged content', (t) => {
  const dir = tmpDir(t);
  const dest = path.join(dir, 'script.sh');
  const owner = `${os.userInfo().uid}:${os.userInfo().gid}`;
  const env = { D: dest, O: owner };
  assert.equal(sh('echo v1 | write_file "$D" 0755 "$O"', env).status, 0);
  const ino1 = fs.statSync(dest).ino;
  assert.equal(fs.statSync(dest).mode & 0o777, 0o755);
  assert.equal(sh('echo v1 | write_file "$D" 0755 "$O"', env).status, 1, 'unchanged -> 1');
  assert.equal(sh('echo v2 | write_file "$D" 0644 "$O"', env).status, 0);
  assert.notEqual(fs.statSync(dest).ino, ino1, 'a running script keeps its old inode');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'v2\n');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o644);
  // a symlink at the destination is replaced, its target is not written
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'keep');
  const link = path.join(dir, 'link');
  fs.symlinkSync(target, link);
  assert.equal(sh('echo new | write_file "$D" 0644 "$O"', { D: link, O: owner }).status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.ok(!fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no temp files left');
});

test('legacy git-pull updater detection', (t) => {
  const dir = tmpDir(t);
  const legacy = path.join(dir, 'legacy.sh');
  fs.writeFileSync(legacy, '#!/bin/bash\nSOURCE_DIR="/home/u/ssh-tunnel"\ngit fetch origin main --quiet\ngit pull origin main --quiet\n');
  const signed = path.join(dir, 'signed.sh');
  fs.writeFileSync(signed, '#!/bin/bash\n# Signed release updater: no git involved.\ncurl -fsSL "$URL"\nopenssl dgst -sha256 -verify "$PUBKEY"\n');
  assert.equal(sh('is_legacy_updater "$F"', { F: legacy }).status, 0);
  assert.notEqual(sh('is_legacy_updater "$F"', { F: signed }).status, 0);
  assert.notEqual(sh('is_legacy_updater "$F"', { F: path.join(dir, 'missing') }).status, 0);
  const repoUpdater = path.join(REPO, 'auto-update.sh');
  if (fs.existsSync(repoUpdater)) {
    const isLegacy = sh('is_legacy_updater "$F"', { F: repoUpdater }).status === 0;
    t.diagnostic(`repo auto-update.sh is ${isLegacy ? 'the legacy git updater' : 'the signed updater'}`);
  }
});

test('firewall rules: TLS mode never opens the API/proxy ports', () => {
  const plain = ok('TLS_MODE=none; API_PORT=4000; PROXY_PORT=4001; TCP_PORT_MIN=10000; TCP_PORT_MAX=10999; firewall_rules');
  assert.deepEqual(plain.trim().split('\n').map((l) => l.split('|')[0]), ['4000/tcp', '4001/tcp', '10000:10999/tcp']);
  const tls = ok('TLS_MODE=new; API_PORT=4000; PROXY_PORT=4001; TCP_PORT_MIN=10000; TCP_PORT_MAX=10999; firewall_rules');
  assert.deepEqual(tls.trim().split('\n').map((l) => l.split('|')[0]), ['80/tcp', '443/tcp', '10000:10999/tcp']);
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.doesNotMatch(src, /ufw --force reset|ufw reset/, 'never resets existing firewall rules');
  assert.doesNotMatch(src, /CREATE TABLE/i, 'schema is owned by the backend');
  assert.doesNotMatch(src, /python3 -c|python3 - /, 'no python for JSON/config handling');
  assert.doesNotMatch(src, /^\s*TLS_(CERT|KEY)=\/etc\/letsencrypt/m, 'never points the service at /etc/letsencrypt');
  assert.match(src, /npm ci --omit=dev/);
});

test('update.conf written by install-server.sh has the same settings as install-client.sh writes', () => {
  const server = ok('render_update_conf 1');
  const client = spawnSync('bash', ['-c', 'source "$0"; UPDATE_ENABLED=1; render_update_conf', path.join(REPO, 'install-client.sh')], {
    encoding: 'utf8', env: { ...process.env, TV_INSTALL_CLIENT_SOURCE_ONLY: '1' },
  });
  assert.equal(client.status, 0, client.stderr);
  const settings = (text) => text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).sort();
  assert.deepEqual(settings(server), settings(client.stdout));
  assert.deepEqual(settings(server), ['ENABLED=1', 'PINNED_VERSION=', 'PUBKEY=/etc/tunnelvault/release-signing.pub',
    'SCHEDULE=12h', 'UPDATE_REPO=TrainABit/ssh-tunnel']);
  // same SCHEDULE rule for both timers
  for (const v of ['12h', '30min', '1d', '99999min']) assert.equal(ok('is_valid_schedule "$V" && echo y', { V: v }).trim(), 'y', v);
  for (const v of ['', '0h', '12', '100000min', '1h;x']) assert.equal(ok('is_valid_schedule "$V" || echo n', { V: v }).trim(), 'n', v);
});
