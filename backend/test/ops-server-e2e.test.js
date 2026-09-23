'use strict';

/**
 * End-to-end runs of install-server.sh `main` inside a fake root:
 * every path constant is redirected into a temp directory and every system
 * command with side effects (apt-get, dpkg, systemctl, ufw, useradd, usermod,
 * groupadd, chown, runuser, sshd, nginx, certbot, npm, curl, journalctl) is a
 * logging stub found first on PATH. Node, sqlite (via the backend), openssl,
 * awk, sed, visudo etc. are real. The host is never modified.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const REPO = path.join(__dirname, '..', '..');
const SYS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const GATEWAY_FILES = ['ssh_router.sh', 'gateway-helper.sh', 'manage-user.sh', 'register_token.sh', 'usermgr-worker.sh', 'tunnelvault-sudoers'];

function writeExec(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** A fake source tree: release package (VERSION + prebuilt dist, no .git) or a git checkout. */
function makeSource(root, { release }) {
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'backend'), { recursive: true });
  fs.cpSync(path.join(REPO, 'backend', 'src'), path.join(src, 'backend', 'src'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, 'backend', f), path.join(src, 'backend', f));
  fs.mkdirSync(path.join(src, 'gateway'));
  for (const f of GATEWAY_FILES) fs.copyFileSync(path.join(REPO, 'gateway', f), path.join(src, 'gateway', f));
  fs.writeFileSync(path.join(src, 'auto-update.sh'), '#!/bin/bash\n# signed release updater (test double)\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'VERSION'), '2.0.0\n');
  fs.mkdirSync(path.join(src, 'frontend'));
  fs.writeFileSync(path.join(src, 'frontend', 'package.json'), '{"name":"frontend","private":true}\n');
  if (release) {
    fs.mkdirSync(path.join(src, 'frontend', 'dist'));
    fs.writeFileSync(path.join(src, 'frontend', 'dist', 'index.html'), '<!doctype html><title>prebuilt</title>\n');
  } else {
    fs.mkdirSync(path.join(src, '.git'));
  }
  return src;
}

function makeRoot(t, { release = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-ops-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const P = {
    root, state, stubs,
    src: makeSource(root, { release }),
    install: path.join(root, 'opt', 'tunnelvault'),
    systemd: path.join(root, 'etc', 'systemd', 'system'),
    sshd: path.join(root, 'etc', 'ssh', 'sshd_config'),
    sudoers: path.join(root, 'etc', 'sudoers.d', 'tunnelvault'),
    logrotate: path.join(root, 'etc', 'logrotate.d', 'tunnelvault'),
    conf: path.join(root, 'etc', 'tunnelvault'),
    nginx: path.join(root, 'etc', 'nginx'),
    acme: path.join(root, 'var', 'www', 'tunnelvault-acme'),
    le: path.join(root, 'etc', 'letsencrypt', 'live'),
    hook: path.join(root, 'etc', 'letsencrypt', 'renewal-hooks', 'deploy', 'tunnelvault-reload-nginx.sh'),
    backups: path.join(root, 'var', 'backups', 'tunnelvault'),
    calls: path.join(state, 'calls.log'),
    clientUpdater: path.join(root, 'opt', 'tunnelvault-client', 'auto-update-client.sh'),
    updateLog: path.join(root, 'var', 'log', 'tunnelvault-update.log'),
  };
  fs.mkdirSync(P.systemd, { recursive: true });
  fs.mkdirSync(path.dirname(P.sshd), { recursive: true });
  fs.writeFileSync(P.sshd, 'Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication no\n');
  fs.mkdirSync(path.join(P.nginx, 'sites-available'), { recursive: true });
  fs.mkdirSync(path.join(P.nginx, 'sites-enabled'), { recursive: true });
  fs.writeFileSync(path.join(state, 'ufw_status'), 'Status: inactive\n');

  const log = `echo "$(basename "$0") $*" >> "${P.calls}"`;
  const simple = ['apt-get', 'useradd', 'groupadd', 'usermod', 'userdel', 'chown', 'journalctl'];
  for (const name of simple) writeExec(path.join(stubs, name), `#!/bin/bash\n${log}\nexit 0\n`);
  writeExec(path.join(stubs, 'curl'), `#!/bin/bash\n${log}\n[[ -f "${state}/health_fail" ]] && exit 7\nexit 0\n`);
  writeExec(path.join(stubs, 'dpkg'), '#!/bin/bash\nexit 0\n');
  writeExec(path.join(stubs, 'systemctl'), `#!/bin/bash
${log}
case "$1" in
  is-active) unit="\${@: -1}"; unit="\${unit%.service}"
             if [[ -f "${state}/active/$unit" ]]; then [[ "$2" == --quiet ]] || echo active; exit 0; fi
             [[ "$2" == --quiet ]] || echo inactive; exit 3 ;;
  is-failed) [[ -f "${state}/health_fail" ]] && exit 0; exit 1 ;;
  stop) rm -f "${state}/active/\${2%.service}" ;;
esac
exit 0
`);
  writeExec(path.join(stubs, 'id'), `#!/bin/bash
u="\${@: -1}"
case "$u" in
  tunnelvault) [[ -f "${state}/svc_user" ]] && { [[ "$1" == -u ]] && echo 999 || echo "uid=999(tunnelvault)"; exit 0; }; exit 1 ;;
  gw-*) echo 1500; exit 0 ;;
esac
exec /usr/bin/id "$@"
`);
  writeExec(path.join(stubs, 'getent'), `#!/bin/bash
if [[ "$1" == passwd && $# -eq 1 ]]; then printf 'root:x:0:0::/root:/bin/bash\\ngw-legacy1:x:1500:1500::/home/gw-legacy1:/bin/false\\n'; exit 0; fi
if [[ "$1" == group && "$2" == tunnelvault-gw && -f "${state}/gw_group" ]]; then exit 0; fi
exit 2
`);
  writeExec(path.join(stubs, 'runuser'), `#!/bin/bash\necho "runuser $1 $2" >> "${P.calls}"\nwhile [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift\nexec "$@"\n`);
  writeExec(path.join(stubs, 'sshd'), `#!/bin/bash\n${log}\n[[ "$1" == -T ]] && printf 'port 22\\nport 2222\\n'\nexit 0\n`);
  writeExec(path.join(stubs, 'ufw'), `#!/bin/bash\n${log}\n[[ "$1" == status ]] && cat "${state}/ufw_status"\nexit 0\n`);
  writeExec(path.join(stubs, 'nginx'), `#!/bin/bash\n${log}\n[[ "$1" == -v ]] && echo "nginx version: nginx/1.24.0" >&2\nexit 0\n`);
  writeExec(path.join(stubs, 'certbot'), `#!/bin/bash
${log}
d=""; while [[ $# -gt 0 ]]; do [[ "$1" == -d ]] && d="$2"; shift; done
[[ -f "${state}/certbot_fail" ]] && { echo "Challenge failed" >&2; exit 1; }
mkdir -p "${P.le}/$d"; echo cert > "${P.le}/$d/fullchain.pem"; echo key > "${P.le}/$d/privkey.pem"
`);
  writeExec(path.join(stubs, 'npm'), `#!/bin/bash
echo "npm $* @ $PWD" >> "${P.calls}"
if [[ "$1" == ci ]] && grep -q '"name": "backend"' package.json; then
  [[ -f "${state}/npm_fail" ]] && { echo "npm ERR! network" >&2; exit 1; }
  cp -R "${path.join(REPO, 'backend', 'node_modules')}" ./node_modules
elif [[ "$1" == run && "$2" == build ]]; then
  mkdir -p dist && echo '<!doctype html><title>built</title>' > dist/index.html
elif [[ "$1" == -v ]]; then echo 10.0.0
fi
exit 0
`);
  if (!spawnSync('bash', ['-c', 'command -v visudo'], { env: { PATH: SYS_PATH } }).stdout.length) {
    writeExec(path.join(stubs, 'visudo'), '#!/bin/bash\nexit 0\n');
  }

  // installer copy without the root check (the tests may run unprivileged)
  let text = fs.readFileSync(path.join(REPO, 'install-server.sh'), 'utf8');
  const rootCheck = /^ {4}\[\[ \$EUID -eq 0 \]\] \|\| fail "This script must be run as root.*$/m;
  assert.match(text, rootCheck);
  text = text.replace(rootCheck, '    : # root check disabled for the test');
  P.installer = path.join(root, 'install-server.sh');
  fs.writeFileSync(P.installer, text, { mode: 0o755 });
  return P;
}

/** Shell lines that point every path constant of install-server.sh into the fake root. */
function pathOverrides(P) {
  return `
INSTALL_DIR="${P.install}"; DATA_DIR="$INSTALL_DIR/data"; LOG_DIR="$INSTALL_DIR/logs"
USERMGR_SPOOL_DIR="$DATA_DIR/usermgr"; DEFAULT_DB_PATH="$DATA_DIR/tunnelvault.db"; DB_PATH="$DEFAULT_DB_PATH"
ENV_FILE="$INSTALL_DIR/backend/.env"; VERSION_FILE="$INSTALL_DIR/VERSION"; UPDATER_SCRIPT="$INSTALL_DIR/auto-update.sh"
SYSTEMD_DIR="${P.systemd}"; SSHD_CONF="${P.sshd}"; SUDOERS_FILE="${P.sudoers}"; LOGROTATE_FILE="${P.logrotate}"
CONF_DIR="${P.conf}"; UPDATE_CONF="$CONF_DIR/update.conf"; INSTALLED_PUBKEY="$CONF_DIR/release-signing.pub"
NGINX_DIR="${P.nginx}"; ACME_WEBROOT="${P.acme}"; LE_LIVE_DIR="${P.le}"; DEPLOY_HOOK="${P.hook}"; BACKUP_DIR="${P.backups}"
CLIENT_UPDATER_SCRIPT="${P.clientUpdater}"; UPDATER_LOG="${P.updateLog}"
ensure_node() { NODE_BIN="${process.execPath}"; info "node (test)"; }
`;
}

function runInstaller(P, args) {
  const overrides = `${pathOverrides(P)}\nSCRIPT_DIR="${P.src}"\n`;
  const r = spawnSync('bash', ['-c', `source "${P.installer}"\n${overrides}\nmain "$@"`, 'install-server.sh', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PATH: `${P.stubs}:${path.dirname(process.execPath)}:${SYS_PATH}` },
  });
  const calls = fs.existsSync(P.calls) ? fs.readFileSync(P.calls, 'utf8') : '';
  if (process.env.TV_E2E_VERBOSE) process.stderr.write(`\n===== install-server.sh ${args.join(' ')}\n${r.stdout}${r.stderr}\n----- calls\n${calls}`);
  return { ...r, calls, out: r.stdout + r.stderr };
}

const read = (f) => fs.readFileSync(f, 'utf8');
const mode = (f) => fs.statSync(f).mode & 0o777;
function envOf(file) { return require('dotenv').parse(read(file)); }

test('fresh install (git checkout, no TLS): files, schema, units, firewall, warning', (t) => {
  const P = makeRoot(t, { release: false });
  const r = runInstaller(P, ['--domain', 'tunnel.example.com']);
  assert.equal(r.status, 0, r.out);

  // application
  const I = P.install;
  assert.ok(fs.existsSync(path.join(I, 'backend', 'src', 'server.js')));
  assert.ok(fs.existsSync(path.join(I, 'backend', 'node_modules', 'better-sqlite3')));
  assert.equal(read(path.join(I, 'VERSION')), '2.0.0\n');
  assert.match(read(path.join(I, 'frontend', 'dist', 'index.html')), /built/, 'checkout -> dashboard rebuilt');
  assert.match(r.calls, /^npm ci --omit=dev --no-audit --no-fund --loglevel=error @ .*\/\.staging\/backend$/m);
  assert.match(r.calls, /^npm run build --silent @ .*\/src\/frontend$/m);
  assert.ok(!fs.existsSync(path.join(I, '.staging')) && !fs.existsSync(path.join(I, '.previous')));
  for (const f of ['ssh_router.sh', 'gateway-helper.sh', 'manage-user.sh', 'register_token.sh', 'usermgr-worker.sh']) {
    assert.equal(mode(path.join(I, f)), 0o755, f);
  }
  assert.equal(read(P.sudoers), read(path.join(REPO, 'gateway', 'tunnelvault-sudoers')));
  assert.equal(mode(P.sudoers), 0o440);
  assert.match(read(P.logrotate), /copytruncate/);

  // configuration
  const envFile = path.join(I, 'backend', '.env');
  assert.equal(mode(envFile), 0o600);
  const env = envOf(envFile);
  assert.equal(env.DOMAIN, 'tunnel.example.com');
  assert.match(env.AUTH_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(env.DATA_ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.equal(env.USERMGR_SPOOL_DIR, path.join(I, 'data', 'usermgr'));
  assert.equal(env.GEOIP_PROVIDER, 'off');
  assert.equal(env.BIND_HOST, '0.0.0.0');
  assert.ok(r.stdout.includes(env.AUTH_TOKEN), 'generated admin token shown once on a fresh install');
  assert.match(r.stdout, /WITHOUT TLS/);

  // data + schema (created by the backend, not by the installer)
  assert.equal(mode(path.join(I, 'data')), 0o700);
  assert.equal(mode(path.join(I, 'data', 'usermgr')), 0o700);
  const db = new Database(path.join(I, 'data', 'tunnelvault.db'), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);
  db.close();
  for (const tbl of ['tokens', 'sessions', 'tunnels', 'ssh_host_keys', 'admin_sessions']) assert.ok(tables.includes(tbl), tbl);
  assert.match(r.calls, /^runuser -u tunnelvault$/m);

  // gateway, units, service
  assert.match(read(P.sshd), /Match User "gw-\*"\n {4}ForceCommand .*\/ssh_router\.sh/);
  assert.match(r.calls, /^usermod --shell .*\/ssh_router\.sh --append --groups tunnelvault-gw gw-legacy1$/m, 'existing gw users migrated');
  assert.match(r.calls, /^groupadd --system tunnelvault-gw$/m);
  for (const u of ['tunnelvault.service', 'tunnelvault-usermgr.path', 'tunnelvault-usermgr.service']) {
    assert.ok(fs.existsSync(path.join(P.systemd, u)), u);
  }
  assert.match(read(path.join(P.systemd, 'tunnelvault.service')), /^ExecStart=.*node .*\/backend\/src\/server\.js$/m);
  assert.match(r.calls, /^systemctl enable --now tunnelvault-usermgr\.path$/m);
  assert.match(r.calls, /^systemctl restart tunnelvault\.service$/m);
  assert.ok(!fs.existsSync(path.join(P.systemd, 'tunnelvault-autoupdate.timer')), 'no updater without opt-in');
  assert.match(r.stdout, /--auto-update --release-pubkey/);

  // firewall: inactive -> defaults, SSH ports, our rules, enable; never reset
  assert.match(r.calls, /^ufw default deny incoming$/m);
  assert.match(r.calls, /^ufw allow 22\/tcp comment SSH$/m);
  assert.match(r.calls, /^ufw allow 2222\/tcp comment SSH$/m, 'custom sshd port kept reachable');
  for (const rule of ['4000/tcp', '4001/tcp', '10000:10999/tcp']) assert.match(r.calls, new RegExp(`^ufw allow ${rule} `, 'm'));
  assert.match(r.calls, /^ufw --force enable$/m);
  assert.doesNotMatch(r.calls, /ufw (--force )?reset/);
  assert.doesNotMatch(r.calls, /^(certbot|nginx) /m);
});

test('upgrade of a 1.x TLS install: env migrated, nginx regenerated, legacy updater removed', (t) => {
  const P = makeRoot(t, { release: true });
  const I = P.install;
  // --- a 1.x installation ---
  fs.mkdirSync(path.join(I, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(I, 'backend', 'src', 'old.js'), '// 1.x');
  fs.writeFileSync(path.join(I, 'backend', 'custom-note.txt'), 'kept');
  fs.mkdirSync(path.join(I, 'data'));
  const oldToken = 'a'.repeat(64);
  fs.writeFileSync(path.join(I, 'backend', '.env'), [
    'PORT=4000', 'PROXY_PORT=4001', 'TCP_PORT_MIN=10000', 'TCP_PORT_MAX=10999', 'DOMAIN=tunnel.example.com',
    `AUTH_TOKEN=${oldToken}`, `DB_PATH=${I}/data/tunnelvault.db`, 'NODE_ENV=production',
    '# TLS_CERT=/path/to/fullchain.pem',
    'TLS_CERT=/etc/letsencrypt/live/tunnel.example.com/fullchain.pem',
    'TLS_KEY=/etc/letsencrypt/live/tunnel.example.com/privkey.pem', '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(P.nginx, 'sites-available', 'tunnelvault'), '# TunnelVault — auto-generated by install-server.sh\nserver { listen 443 ssl; }\n');
  fs.mkdirSync(path.join(P.le, 'tunnel.example.com'), { recursive: true });
  fs.writeFileSync(path.join(P.le, 'tunnel.example.com', 'fullchain.pem'), 'cert');
  fs.writeFileSync(path.join(I, 'auto-update.sh'), '#!/bin/bash\nSOURCE_DIR="/home/u/ssh-tunnel"\ngit pull origin main --quiet\n');
  fs.writeFileSync(path.join(P.systemd, 'tunnelvault-autoupdate.timer'), '[Timer]\nOnUnitActiveSec=12h\n');
  fs.writeFileSync(path.join(P.systemd, 'tunnelvault-autoupdate.service'), '[Service]\nExecStart=/opt/tunnelvault/auto-update.sh\n');
  fs.writeFileSync(path.join(P.systemd, 'tunnelvault-api.service'), '[Service]\n');
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  fs.writeFileSync(path.join(P.state, 'gw_group'), '');
  fs.writeFileSync(path.join(P.state, 'active', 'tunnelvault'), '');
  fs.writeFileSync(path.join(P.state, 'ufw_status'), 'Status: active\n\nTo Action From\n4000/tcp ALLOW Anywhere\n');

  const r = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(r.status, 0, r.out);

  // code replaced, unknown files in backend/ kept, prebuilt dashboard used
  assert.ok(!fs.existsSync(path.join(I, 'backend', 'src', 'old.js')));
  assert.equal(read(path.join(I, 'backend', 'custom-note.txt')), 'kept');
  assert.match(read(path.join(I, 'frontend', 'dist', 'index.html')), /prebuilt/);
  assert.doesNotMatch(r.calls, /^npm run build/m, 'release package: no frontend build');
  assert.ok(r.calls.indexOf('systemctl stop tunnelvault.service') < r.calls.indexOf('systemctl restart tunnelvault.service'));

  // env: preserved + migrated
  const envText = read(path.join(I, 'backend', '.env'));
  const env = envOf(path.join(I, 'backend', '.env'));
  assert.equal(env.AUTH_TOKEN, oldToken);
  assert.equal(env.TLS_CERT, undefined);
  assert.equal(env.TLS_KEY, undefined);
  assert.match(envText, /^# Disabled by install-server\.sh .*TLS_CERT=\/etc\/letsencrypt/m);
  assert.match(env.DATA_ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.equal(env.USERMGR_SPOOL_DIR, path.join(I, 'data', 'usermgr'));
  assert.equal(env.GEOIP_PROVIDER, 'off');
  assert.equal(env.SESSION_RETENTION_DAYS, '90');
  assert.equal(env.BIND_HOST, '127.0.0.1');
  assert.equal(env.TRUST_PROXY, 'loopback');
  assert.equal(env.PUBLIC_URL, 'https://tunnel.example.com');
  assert.equal(env.HTTP_TUNNEL_URL_TEMPLATE, 'http://{subdomain}.tunnel.example.com');
  assert.ok(!r.out.includes(oldToken), 'the admin token is never printed on upgrade');
  assert.ok(fs.readdirSync(P.backups).some((f) => f.startsWith('env.')), 'previous .env backed up');

  // nginx regenerated (v1 file had the legacy marker), old one backed up, deploy hook installed
  const site = read(path.join(P.nginx, 'sites-available', 'tunnelvault'));
  assert.match(site, /^# Managed by TunnelVault install-server\.sh/);
  assert.match(site, /location \^~ \/ws\/ssh/);
  assert.ok(fs.readdirSync(P.backups).some((f) => f.startsWith('nginx-tunnelvault.')));
  assert.equal(fs.readlinkSync(path.join(P.nginx, 'sites-enabled', 'tunnelvault')), path.join(P.nginx, 'sites-available', 'tunnelvault'));
  assert.equal(mode(P.hook), 0o755);
  assert.doesNotMatch(r.calls, /^certbot /m, 'existing certificate reused');

  // legacy git-pull updater and legacy API unit removed
  assert.ok(!fs.existsSync(path.join(I, 'auto-update.sh')));
  assert.ok(!fs.existsSync(path.join(P.systemd, 'tunnelvault-autoupdate.timer')));
  assert.ok(!fs.existsSync(path.join(P.systemd, 'tunnelvault-api.service')));
  assert.match(r.calls, /^systemctl disable --now tunnelvault-autoupdate\.timer$/m);
  assert.match(r.out, /Removed the old auto-updater/);

  // firewall active: only our rules added, TLS mode does not open 4000/4001
  assert.doesNotMatch(r.calls, /^ufw (default|--force enable)/m);
  assert.match(r.calls, /^ufw allow 80\/tcp /m);
  assert.match(r.calls, /^ufw allow 443\/tcp /m);
  assert.doesNotMatch(r.calls, /^ufw allow 400[01]\/tcp/m);
  assert.match(r.out, /ufw delete allow 4000\/tcp/, 'hint about the obsolete rule');
});

test('fresh --tls --auto-update install from a release package', (t) => {
  const P = makeRoot(t, { release: true });
  const key = path.join(P.root, 'release.key');
  const pub = path.join(P.root, 'release-signing.pub');
  assert.equal(spawnSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]).status, 0);
  assert.equal(spawnSync('openssl', ['ec', '-in', key, '-pubout', '-out', pub]).status, 0);
  const r = runInstaller(P, ['--domain', 'Tunnel.Example.com', '--tls', '--email', 'ops@example.com',
    '--auto-update', '--release-pubkey', pub, '--auth-token', 'b'.repeat(40)]);
  assert.equal(r.status, 0, r.out);

  const env = envOf(path.join(P.install, 'backend', '.env'));
  assert.equal(env.DOMAIN, 'tunnel.example.com');
  assert.equal(env.AUTH_TOKEN, 'b'.repeat(40));
  assert.equal(env.BIND_HOST, '127.0.0.1');
  assert.equal(env.TRUST_PROXY, 'loopback');
  assert.equal(env.PUBLIC_URL, 'https://tunnel.example.com');
  assert.equal(env.TLS_CERT, undefined);
  assert.ok(!r.stdout.includes('b'.repeat(40)), 'a provided token is not echoed');

  // certbot: apex only, webroot, e-mail, then the HTTPS configuration
  assert.match(r.calls, new RegExp(`^certbot certonly --webroot -w ${P.acme} -d tunnel\\.example\\.com --cert-name tunnel\\.example\\.com --non-interactive --agree-tos --keep-until-expiring --email ops@example\\.com$`, 'm'));
  assert.doesNotMatch(r.calls, /\*\.tunnel\.example\.com|--nginx/, 'no wildcard via HTTP-01, no nginx plugin');
  const site = read(path.join(P.nginx, 'sites-available', 'tunnelvault'));
  assert.match(site, /listen 443 ssl/);
  assert.match(site, new RegExp(`ssl_certificate {5}${P.le}/tunnel\\.example\\.com/fullchain\\.pem;`));
  assert.match(r.out, /nginx serves https:\/\/tunnel\.example\.com/);
  assert.match(r.stdout, /Dashboard: +https:\/\/tunnel\.example\.com/);
  assert.doesNotMatch(r.stdout, /WITHOUT TLS/);

  // signed updater
  const conf = read(path.join(P.conf, 'update.conf'));
  for (const line of ['ENABLED=1', 'SCHEDULE=12h', 'UPDATE_REPO=TrainABit/ssh-tunnel', 'PINNED_VERSION=', `PUBKEY=${P.conf}/release-signing.pub`]) {
    assert.ok(conf.split('\n').includes(line), line);
  }
  assert.equal(mode(path.join(P.conf, 'update.conf')), 0o644);
  assert.equal(read(path.join(P.conf, 'release-signing.pub')), read(pub));
  assert.equal(mode(path.join(P.install, 'auto-update.sh')), 0o755);
  assert.match(read(path.join(P.systemd, 'tunnelvault-autoupdate.timer')), /^RandomizedDelaySec=1h$/m);
  assert.match(r.calls, /^systemctl enable --now tunnelvault-autoupdate\.timer$/m);

  // firewall: 80/443 + TCP range, never 4000/4001
  assert.match(r.calls, /^ufw allow 80\/tcp /m);
  assert.match(r.calls, /^ufw allow 443\/tcp /m);
  assert.doesNotMatch(r.calls, /^ufw allow 400[01]\/tcp/m);

  // second run (what the updater does): keeps the choice, no new certificate
  fs.writeFileSync(P.calls, '');
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  const again = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(again.status, 0, again.out);
  assert.match(again.calls, /^systemctl enable --now tunnelvault-autoupdate\.timer$/m, 'updater kept enabled');
  assert.doesNotMatch(again.calls, /^certbot /m);
  assert.match(again.out, /nginx serves https/);
});

test('--tls: certbot failure is reported and the exit code is non-zero', (t) => {
  const P = makeRoot(t, { release: true });
  fs.writeFileSync(path.join(P.state, 'certbot_fail'), '');
  const r = runInstaller(P, ['--domain', 'tunnel.example.com', '--tls']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /certbot could not obtain a certificate/);
  assert.match(r.calls, /^certbot certonly --webroot .* --register-unsafely-without-email$/m, 'no --email -> no account e-mail');
  const site = read(path.join(P.nginx, 'sites-available', 'tunnelvault'));
  assert.match(site, /acme-challenge/);
  assert.doesNotMatch(site, /listen 443/, 'HTTPS config only after the certificate exists');
  assert.match(r.stdout, /Admin token/, 'the generated token is still shown');
});

test('safety: npm failure leaves the running install untouched; refusals', (t) => {
  const P = makeRoot(t, { release: true });
  const I = P.install;
  fs.mkdirSync(path.join(I, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(I, 'backend', 'src', 'server.js'), '// running version');
  fs.writeFileSync(path.join(I, 'backend', '.env'), 'PORT=4000\nDOMAIN=tunnel.example.com\n', { mode: 0o600 });
  fs.writeFileSync(path.join(P.state, 'active', 'tunnelvault'), '');
  fs.writeFileSync(path.join(P.state, 'npm_fail'), '');
  let r = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.out, /npm ci failed — the running installation was not changed/);
  assert.equal(read(path.join(I, 'backend', 'src', 'server.js')), '// running version');
  assert.doesNotMatch(r.calls, /systemctl stop/);
  fs.rmSync(path.join(P.state, 'npm_fail'));

  // non-interactive fresh install over an existing one is refused
  r = runInstaller(P, ['--yes']);
  assert.equal(r.status, 1);
  assert.match(r.out, /Refusing to overwrite the existing configuration non-interactively/);

  // a symlinked .env (planted by the service user) is never followed
  const victim = path.join(P.root, 'victim');
  fs.writeFileSync(victim, 'secret');
  fs.rmSync(path.join(I, 'backend', '.env'));
  fs.symlinkSync(victim, path.join(I, 'backend', '.env'));
  r = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.out, /is not a regular file/);
  assert.equal(read(victim), 'secret');

  // --auto-update without a key is refused up front
  fs.rmSync(path.join(I, 'backend', '.env'));
  r = runInstaller(P, ['--auto-update']);
  assert.equal(r.status, 1);
  assert.match(r.out, /--auto-update needs the release public key/);

  // --tls needs a public domain
  r = runInstaller(P, ['--tls']);
  assert.equal(r.status, 1);
  assert.match(r.out, /TLS needs a public domain/);
});

/** uninstall-server.sh with its paths pointed into the fake root (and stubs for userdel & co). */
function makeUninstaller(P) {
  const replace = {
    INSTALL_DIR: P.install, SYSTEMD_DIR: P.systemd, SSHD_CONF: P.sshd, SUDOERS_FILE: P.sudoers,
    LOGROTATE_FILE: P.logrotate, CONF_DIR: P.conf, NGINX_DIR: P.nginx, ACME_WEBROOT: P.acme,
    DEPLOY_HOOK: P.hook, BACKUP_DIR: P.backups, UPDATE_LOG: P.updateLog,
    UPDATE_LOCK: path.join(P.state, 'update.lock'), CLIENT_INSTALL_DIR: path.dirname(P.clientUpdater),
  };
  let text = fs.readFileSync(path.join(REPO, 'uninstall-server.sh'), 'utf8');
  for (const [k, v] of Object.entries(replace)) {
    const re = new RegExp(`^${k}=".*"$`, 'm');
    assert.match(text, re, k);
    text = text.replace(re, () => `${k}="${v}"`);
  }
  const rootCheck = /^\[\[ \$EUID -eq 0 \]\] \|\| fail "Run as root.*$/m;
  assert.match(text, rootCheck);
  text = text.replace(rootCheck, ': # root check disabled for the test');
  const uninstaller = path.join(P.root, 'uninstall-server.sh');
  fs.writeFileSync(uninstaller, text, { mode: 0o755 });
  writeExec(path.join(P.stubs, 'groupdel'), `#!/bin/bash\necho "groupdel $*" >> "${P.calls}"\n`);
  writeExec(path.join(P.stubs, 'pkill'), `#!/bin/bash\necho "pkill $*" >> "${P.calls}"\nexit 1\n`);
  writeExec(path.join(P.stubs, 'getent'), `#!/bin/bash
if [[ "$1" == passwd && $# -eq 1 ]]; then printf 'root:x:0:0::/root:/bin/bash\\ngw-abc123:x:1500:1500::/home/gw-abc123:/opt/tunnelvault/ssh_router.sh\\nalice:x:1000:1000::/home/alice:/bin/bash\\n'; exit 0; fi
[[ "$1" == group ]] && exit 0
exit 2
`);
  return uninstaller;
}

test('uninstall-server.sh removes what the installer created and keeps a backup', (t) => {
  const P = makeRoot(t, { release: true });
  let r = runInstaller(P, ['--domain', 'tunnel.example.com', '--tls']);
  assert.equal(r.status, 0, r.out);
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  fs.writeFileSync(path.join(P.state, 'gw_group'), '');
  fs.writeFileSync(path.join(P.state, 'ufw_status'), 'Status: active\n');
  const client = path.join(P.conf, 'client.env');
  fs.mkdirSync(P.conf, { recursive: true });
  fs.writeFileSync(path.join(P.conf, 'update.conf'), 'ENABLED=1\n');

  const uninstaller = makeUninstaller(P);

  // shared /etc/tunnelvault (client installed on the same host) is kept
  fs.writeFileSync(client, 'TUNNELVAULT_SERVER=wss://x\n');
  fs.writeFileSync(P.calls, '');
  r = spawnSync('bash', [uninstaller, '--yes'], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, PATH: `${P.stubs}:${SYS_PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = fs.readFileSync(P.calls, 'utf8');

  assert.ok(!fs.existsSync(P.install), '/opt/tunnelvault removed');
  for (const u of ['tunnelvault.service', 'tunnelvault-usermgr.path', 'tunnelvault-usermgr.service']) {
    assert.ok(!fs.existsSync(path.join(P.systemd, u)), u);
    assert.match(calls, new RegExp(`^systemctl disable --now ${u.replace('.', '\\.')}$`, 'm'));
  }
  assert.ok(!fs.existsSync(P.sudoers) && !fs.existsSync(P.logrotate) && !fs.existsSync(P.hook) && !fs.existsSync(P.acme));
  assert.ok(!fs.existsSync(path.join(P.nginx, 'sites-available', 'tunnelvault')));
  assert.ok(!fs.existsSync(path.join(P.nginx, 'sites-enabled', 'tunnelvault')));
  assert.doesNotMatch(read(P.sshd), /TUNNELVAULT-GATEWAY/);
  assert.match(read(P.sshd), /PasswordAuthentication no/);
  assert.match(calls, /^userdel -r gw-abc123$/m);
  assert.doesNotMatch(calls, /userdel -r alice/);
  assert.match(calls, /^groupdel tunnelvault-gw$/m);
  assert.match(calls, /^ufw delete allow 10000:10999\/tcp$/m);
  assert.doesNotMatch(calls, /ufw delete allow (22|80|443)\//);
  assert.ok(fs.existsSync(client) && fs.existsSync(path.join(P.conf, 'update.conf')), 'client configuration untouched');
  assert.ok(fs.existsSync(path.join(P.le, 'tunnel.example.com', 'fullchain.pem')), 'certificates kept');
  assert.ok(fs.existsSync(P.src), 'source kept with --yes');

  const backups = fs.readdirSync(P.backups).filter((f) => f.startsWith('tunnelvault-backup-'));
  assert.equal(backups.length, 1);
  const archive = path.join(P.backups, backups[0]);
  assert.equal(mode(archive), 0o600);
  const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;
  assert.match(list, /^data\/tunnelvault\.db$/m);
  assert.match(list, /^backend\/\.env$/m);
  assert.match(r.stdout, /Backup: +.*tunnelvault-backup-/);
});

// ── Contract: signed updater (auto-update.sh) -> install-server.sh --upgrade --yes ──────────

/** Async spawn (keeps the event loop free for the in-process release server). */
function spawnAsync(cmd, args, { env, timeoutMs = 120000 } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (process.env.TV_E2E_VERBOSE) process.stderr.write(`\n===== ${args.join(' ')}\n${out}`);
      resolve({ status, out });
    });
  });
}

/** Loopback "GitHub": /download/<tag>/<asset> from dirs[tag]. */
async function startReleaseServer(t, dirs) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const m = /^\/download\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(req.url);
    const file = m && dirs[m[1]] && path.join(dirs[m[1]], m[2]);
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function makeReleaseKey(dir) {
  const key = path.join(dir, 'release.key');
  const pub = path.join(dir, 'release-signing.pub');
  assert.equal(spawnSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]).status, 0);
  assert.equal(spawnSync('openssl', ['ec', '-in', key, '-pubout', '-out', pub], { stdio: 'ignore' }).status, 0);
  return { key, pub };
}

/**
 * A signed release tunnelvault-vVERSION.tar.gz like build-release.sh makes it, except that its
 * install-server.sh is a shim: it records how the updater called it, then sources the REAL
 * installer of the package (install-server.real.sh — SCRIPT_DIR stays the extracted tree) and
 * runs `main` with every path pointed into the fake root and the system commands stubbed.
 * The updater runs with a fixed PATH, so the shim re-adds the stubs first.
 */
function buildSignedServerRelease(P, version, keyFile) {
  const work = fs.mkdtempSync(path.join(P.root, 'release-build-'));
  const name = `tunnelvault-v${version}`;
  const tree = path.join(work, name);
  fs.mkdirSync(path.join(tree, 'backend'), { recursive: true });
  fs.cpSync(path.join(REPO, 'backend', 'src'), path.join(tree, 'backend', 'src'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(REPO, 'backend', f), path.join(tree, 'backend', f));
  fs.mkdirSync(path.join(tree, 'gateway'));
  for (const f of GATEWAY_FILES) fs.copyFileSync(path.join(REPO, 'gateway', f), path.join(tree, 'gateway', f));
  fs.mkdirSync(path.join(tree, 'frontend', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'frontend', 'package.json'), '{"name":"frontend","private":true}\n');
  fs.writeFileSync(path.join(tree, 'frontend', 'dist', 'index.html'), `<!doctype html><title>prebuilt ${version}</title>\n`);
  fs.writeFileSync(path.join(tree, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(tree, 'auto-update.sh'), `${read(path.join(REPO, 'auto-update.sh'))}# release ${version}\n`, { mode: 0o755 });
  fs.copyFileSync(P.installer, path.join(tree, 'install-server.real.sh'));
  const shim = `#!/bin/bash
export PATH="${P.stubs}:${path.dirname(process.execPath)}:${SYS_PATH}"
printf 'args=%s\\nupdater=%s\\ncwd=%s\\nstdin=%s\\n' "$*" "\${TUNNELVAULT_UPDATER:-}" "$PWD" "$(readlink /proc/self/fd/0)" > "${P.state}/shim-called"
source "$(dirname "\${BASH_SOURCE[0]}")/install-server.real.sh"
${pathOverrides(P)}
main "$@"
`;
  fs.writeFileSync(path.join(tree, 'install-server.sh'), shim, { mode: 0o755 });

  const out = path.join(work, 'assets');
  fs.mkdirSync(out);
  const tarball = path.join(out, `${name}.tar.gz`);
  const tar = spawnSync('tar', ['-C', work, '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, name], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const digest = require('crypto').createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${digest}  ${name}.tar.gz\n`);
  const sign = spawnSync('openssl', ['dgst', '-sha256', '-sign', keyFile, '-out', path.join(out, 'SHA256SUMS.sig'), path.join(out, 'SHA256SUMS')], { encoding: 'utf8' });
  assert.equal(sign.status, 0, sign.stderr);
  fs.rmSync(tree, { recursive: true, force: true });
  return { dir: out, autoUpdate: `${read(path.join(REPO, 'auto-update.sh'))}# release ${version}\n` };
}

function updaterEnv(P, baseUrl) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/_proxy$/i.test(k)) delete env[k];
  return {
    ...env,
    NO_PROXY: '*',
    no_proxy: '*',
    TMPDIR: P.tmp,
    TUNNELVAULT_UPDATE_CONF: path.join(P.conf, 'update.conf'),
    TUNNELVAULT_INSTALL_DIR: P.install,
    TUNNELVAULT_UPDATE_LOG: P.updateLog,
    TUNNELVAULT_UPDATE_LOCK: path.join(P.state, 'update.lock'),
    UPDATE_BASE_URL: `${baseUrl}/download`,
    UPDATE_API_URL: `${baseUrl}/api/latest`,
  };
}

/** Files of the installation that must never point into the (deleted) staging tree. */
function filesMentioning(dirs, needle) {
  const hits = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    const st = fs.lstatSync(d);
    if (st.isFile()) { if (read(d).includes(needle)) hits.push(d); return; }
    if (!st.isDirectory()) return;
    for (const e of fs.readdirSync(d)) if (e !== 'node_modules') walk(path.join(d, e));
  };
  dirs.forEach(walk);
  return hits;
}

test('contract: auto-update.sh runs install-server.sh --upgrade --yes from the verified release', async (t) => {
  const P = makeRoot(t, { release: true });
  P.tmp = path.join(P.root, 'tmp');
  fs.mkdirSync(P.tmp);
  fs.mkdirSync(path.dirname(P.updateLog), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'auto-update.sh'), path.join(P.src, 'auto-update.sh')); // the real updater
  const keys = makeReleaseKey(P.root);

  // 2.0.0 installed with the signed updater; the admin tuned update.conf afterwards
  let r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(path.join(P.install, 'auto-update.sh')), read(path.join(REPO, 'auto-update.sh')));
  assert.equal(mode(P.conf), 0o755, '/etc/tunnelvault readable by the backend, not writable');
  assert.match(r.stdout, /run now: sudo .*\/auto-update\.sh \[--dry-run\]/);
  assert.match(r.stdout, /logs: journalctl -u tunnelvault-autoupdate and .*tunnelvault-update\.log/);
  const confFile = path.join(P.conf, 'update.conf');
  fs.writeFileSync(confFile, read(confFile).replace(/^SCHEDULE=.*$/m, 'SCHEDULE=6h').replace(/^PINNED_VERSION=.*$/m, 'PINNED_VERSION=2.0.1')
    .replace(/^UPDATE_REPO=.*$/m, 'UPDATE_REPO=example/tunnelvault-fork'));
  const token = envOf(path.join(P.install, 'backend', '.env')).AUTH_TOKEN;
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  fs.writeFileSync(path.join(P.state, 'gw_group'), '');
  fs.writeFileSync(path.join(P.state, 'active', 'tunnelvault'), '');
  const pubBefore = read(path.join(P.conf, 'release-signing.pub'));

  const release = buildSignedServerRelease(P, '2.0.1', keys.key);
  const baseUrl = await startReleaseServer(t, { 'v2.0.1': release.dir });
  fs.writeFileSync(P.calls, '');
  const u = await spawnAsync('bash', [path.join(P.install, 'auto-update.sh')], { env: updaterEnv(P, baseUrl) });
  assert.equal(u.status, 0, u.out);
  assert.match(u.out, /Signature and checksum verified for tunnelvault-v2\.0\.1\.tar\.gz/);
  assert.match(u.out, /Update to v2\.0\.1 complete/);
  assert.ok(!u.out.includes(token), 'admin token never logged');

  // how the updater invoked the installer
  const shim = Object.fromEntries(read(path.join(P.state, 'shim-called')).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(shim.args, '--upgrade --yes');
  assert.equal(shim.updater, '1');
  assert.equal(shim.stdin, '/dev/null');
  assert.match(shim.cwd, new RegExp(`^${P.tmp}/tunnelvault-update\\.[^/]+/src/tunnelvault-v2\\.0\\.1$`));
  assert.deepEqual(fs.readdirSync(P.tmp), [], 'staging tree deleted after the run');

  // result: new version from the prebuilt dist, config + choices kept, updater replaced atomically
  const I = P.install;
  assert.equal(read(path.join(I, 'VERSION')), '2.0.1\n');
  assert.match(read(path.join(I, 'frontend', 'dist', 'index.html')), /prebuilt 2\.0\.1/);
  assert.doesNotMatch(r.calls + read(P.calls), /^npm run build/m);
  assert.ok(read(P.calls).indexOf('systemctl stop tunnelvault.service') < read(P.calls).indexOf('systemctl restart tunnelvault.service'));
  assert.equal(envOf(path.join(I, 'backend', '.env')).AUTH_TOKEN, token);
  const conf = read(confFile).split('\n');
  for (const line of ['ENABLED=1', 'SCHEDULE=6h', 'PINNED_VERSION=2.0.1', 'UPDATE_REPO=example/tunnelvault-fork']) assert.ok(conf.includes(line), line);
  assert.equal(mode(confFile), 0o644);
  assert.equal(fs.statSync(confFile).uid, process.getuid());
  assert.match(read(path.join(P.systemd, 'tunnelvault-autoupdate.timer')), /^OnUnitActiveSec=6h$/m);
  const unit = read(path.join(P.systemd, 'tunnelvault-autoupdate.service'));
  assert.match(unit, new RegExp(`^ExecStart=${I}/auto-update\\.sh$`, 'm'));
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^User=root$/m);
  assert.equal(mode(I), 0o755, '/opt/tunnelvault: root-owned code, not writable by the service user');
  assert.equal(read(path.join(I, 'auto-update.sh')), release.autoUpdate, 'updater replaced by the verified release copy');
  assert.equal(mode(path.join(I, 'auto-update.sh')), 0o755);
  assert.equal(read(path.join(P.conf, 'release-signing.pub')), pubBefore, 'trust anchor never replaced implicitly');
  assert.deepEqual(filesMentioning([I, P.systemd, P.conf, P.sudoers, P.logrotate, P.nginx], P.tmp), [],
    'nothing persisted that points into the deleted release tree');

  // second run: up to date, installer not run again
  fs.rmSync(path.join(P.state, 'shim-called'));
  const again = await spawnAsync('bash', [path.join(I, 'auto-update.sh')], { env: updaterEnv(P, baseUrl) });
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /Up to date \(v2\.0\.1\)/);
  assert.ok(!fs.existsSync(path.join(P.state, 'shim-called')));
});

test('contract: an unhealthy service after the upgrade fails the updater run', async (t) => {
  const P = makeRoot(t, { release: true });
  P.tmp = path.join(P.root, 'tmp');
  fs.mkdirSync(P.tmp);
  fs.mkdirSync(path.dirname(P.updateLog), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'auto-update.sh'), path.join(P.src, 'auto-update.sh'));
  const keys = makeReleaseKey(P.root);
  const r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  fs.writeFileSync(path.join(P.state, 'gw_group'), '');
  fs.writeFileSync(path.join(P.state, 'health_fail'), '');
  const confFile = path.join(P.conf, 'update.conf');
  fs.writeFileSync(confFile, read(confFile).replace(/^PINNED_VERSION=.*$/m, 'PINNED_VERSION=2.0.1'));
  const release = buildSignedServerRelease(P, '2.0.1', keys.key);
  const baseUrl = await startReleaseServer(t, { 'v2.0.1': release.dir });
  const u = await spawnAsync('bash', [path.join(P.install, 'auto-update.sh')], { env: updaterEnv(P, baseUrl) });
  assert.equal(u.status, 1, u.out);
  assert.match(u.out, /service did not become healthy/);
  assert.match(u.out, /install-server\.sh failed while installing v2\.0\.1/);
  assert.match(read(P.updateLog), /install-server\.sh failed/);
  assert.deepEqual(fs.readdirSync(P.tmp), [], 'staging tree deleted after a failed run too');
});

test('updater choices: paused updater kept on --upgrade, shared update.conf, P-256 keys only', (t) => {
  const P = makeRoot(t, { release: true });
  const keys = makeReleaseKey(P.root);
  const rsa = path.join(P.root, 'rsa.pub');
  assert.equal(spawnSync('bash', ['-c', `openssl genrsa 2048 2>/dev/null | openssl rsa -pubout -out "${rsa}" 2>/dev/null`]).status, 0);

  // an RSA key is refused before anything is installed (the updater only accepts P-256)
  let r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', rsa]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not an ECDSA P-256 public key/);
  assert.ok(!fs.existsSync(P.install));

  r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  fs.writeFileSync(path.join(P.state, 'gw_group'), '');
  const confFile = path.join(P.conf, 'update.conf');
  const timer = path.join(P.systemd, 'tunnelvault-autoupdate.timer');

  // paused by the admin (ENABLED=0): an upgrade keeps it installed and paused
  fs.writeFileSync(confFile, read(confFile).replace(/^ENABLED=1$/m, 'ENABLED=0'));
  fs.writeFileSync(path.join(P.install, 'auto-update.sh'), '#!/bin/bash\n# older signed updater\n', { mode: 0o755 });
  fs.writeFileSync(P.calls, '');
  r = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.match(read(confFile), /^ENABLED=0$/m, 'pause kept');
  assert.ok(fs.existsSync(timer));
  assert.equal(read(path.join(P.install, 'auto-update.sh')), read(path.join(P.src, 'auto-update.sh')), 'updater script refreshed');
  assert.match(r.stdout, /Auto-update: +installed but paused/);

  // --auto-update resumes it
  r = runInstaller(P, ['--upgrade', '--yes', '--auto-update']);
  assert.equal(r.status, 0, r.out);
  assert.match(read(confFile), /^ENABLED=1$/m);
  assert.match(r.stdout, /Auto-update: +enabled \(signed releases, every 12h\)/);

  // client updater on the same host: --no-auto-update removes only the server's units and
  // leaves ENABLED alone (it would pause the client updater too)
  fs.mkdirSync(path.dirname(P.clientUpdater), { recursive: true });
  fs.writeFileSync(P.clientUpdater, '#!/bin/bash\n# >>> tv-updater-common\n');
  fs.writeFileSync(path.join(P.systemd, 'tunnelvault-client-autoupdate.timer'), '[Timer]\n');
  r = runInstaller(P, ['--upgrade', '--yes', '--no-auto-update']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(timer) && !fs.existsSync(path.join(P.install, 'auto-update.sh')));
  assert.match(read(confFile), /^ENABLED=1$/m);
  assert.match(r.out, /shared with the client auto-updater/);
  assert.ok(fs.existsSync(path.join(P.conf, 'release-signing.pub')), 'trust anchor kept for the client');

  // re-enable while the client shares the file: the installer says so
  r = runInstaller(P, ['--upgrade', '--yes', '--auto-update']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ENABLED=0 pauses both/);

  // without a client updater, --no-auto-update also records ENABLED=0 (read by the dashboard)
  fs.rmSync(path.join(P.systemd, 'tunnelvault-client-autoupdate.timer'));
  r = runInstaller(P, ['--upgrade', '--yes', '--no-auto-update']);
  assert.equal(r.status, 0, r.out);
  assert.match(read(confFile), /^ENABLED=0$/m);
  r = runInstaller(P, ['--upgrade', '--yes']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.existsSync(timer), 'a disabled updater stays off on upgrade');
  assert.match(r.stdout, /Auto-update: +disabled/);
});

test('uninstall-server.sh: updater files removed, /etc/tunnelvault kept only while the client is installed', (t) => {
  const P = makeRoot(t, { release: true });
  const keys = makeReleaseKey(P.root);
  let r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  fs.writeFileSync(path.join(P.state, 'svc_user'), '');
  const uninstaller = makeUninstaller(P);
  const uninstall = () => spawnSync('bash', [uninstaller, '--yes', '--no-backup'], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, PATH: `${P.stubs}:${SYS_PATH}` },
  });

  // client code present (no client.env yet): shared update.conf + key stay
  fs.mkdirSync(path.dirname(P.updateLog), { recursive: true });
  fs.writeFileSync(P.updateLog, 'log\n');
  fs.writeFileSync(path.join(P.state, 'update.lock'), '');
  fs.mkdirSync(path.dirname(P.clientUpdater), { recursive: true });
  r = uninstall();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const u of ['tunnelvault-autoupdate.timer', 'tunnelvault-autoupdate.service']) assert.ok(!fs.existsSync(path.join(P.systemd, u)), u);
  assert.match(fs.readFileSync(P.calls, 'utf8'), /^systemctl disable --now tunnelvault-autoupdate\.timer$/m);
  assert.ok(!fs.existsSync(P.updateLog), 'updater log removed');
  assert.ok(!fs.existsSync(path.join(P.state, 'update.lock')));
  assert.ok(!fs.existsSync(path.join(P.install, 'auto-update.sh')));
  assert.ok(fs.existsSync(path.join(P.conf, 'update.conf')) && fs.existsSync(path.join(P.conf, 'release-signing.pub')));
  assert.match(r.stdout, /shared with the TunnelVault client on this host — kept/);

  // no client: the updater configuration goes too
  fs.rmSync(path.dirname(P.clientUpdater), { recursive: true });
  r = runInstaller(P, ['--domain', 'tunnel.example.com', '--auto-update', '--release-pubkey', keys.pub]);
  assert.equal(r.status, 0, r.out);
  r = uninstall();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(P.conf), '/etc/tunnelvault removed');
});
