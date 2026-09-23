#!/bin/bash
# ================================================================
# TunnelVault — Client Installer
#
# Usage:
#   sudo bash install-client.sh --server wss://tunnel.example.com --token TOKEN [options]
#   sudo bash install-client.sh --upgrade [options]
#
# Options:
#   --server URL             Server URL: wss://HOST[:PORT][/PATH] (TLS) or ws://HOST[:PORT]
#                            (plaintext — only for LAN/testing). Required for a fresh install.
#   --token TOKEN            Device token from the dashboard (letters and digits, max 64).
#   --token-file FILE        Read the token from FILE instead (keeps it out of `ps`).
#   --port PORT              Local port of the main tunnel (default: 22).
#   --protocol tcp|http      Protocol of the main tunnel (default: tcp).
#   --extra-port P:PROTO:NAME  Additional tunnel, repeatable (e.g. 8080:http:web).
#                            NAME: letters, digits, '.', '_' or '-' (max 64).
#   --user USER              Linux user the service runs as (default: the sudo user;
#                            kept on --upgrade).
#   --allow-reboot           Let the dashboard reboot this device (sudoers rule for
#                            `systemctl reboot` / `reboot` only). Off by default.
#   --no-reboot              Disable remote reboot again.
#   --auto-update            Install the signed-release auto-updater (needs a release
#                            public key: --release-pubkey FILE or release-signing.pub
#                            next to this script).
#   --no-auto-update         Remove the auto-updater.
#   --release-pubkey FILE    Release signing public key (ECDSA P-256 PEM).
#   --upgrade                Upgrade in place: keeps server, token, tunnels, service user,
#                            remote-reboot and auto-update settings unless overridden.
#   --yes                    Non-interactive (accepted for symmetry; never prompts).
#   -h, --help               Show this help.
#
# Files: server URL, token and the remote-reboot switch in /etc/tunnelvault/client.env
# (0600 root, systemd EnvironmentFile=); settings without the token in
# /etc/tunnelvault/config.json (root:<service group> 0640, read by the service) and a copy
# in ~SERVICE_USER/.tunnelvault/config.json (0600, for the CLI); reconnect state (keeps the
# public ports) in /var/lib/tunnelvault (StateDirectory=); code in /opt/tunnelvault-client.
# /etc/tunnelvault/update.conf + release-signing.pub are shared with the server's updater
# when both are installed on one host (ENABLED=0 there pauses both updaters).
# ================================================================
set -Eeuo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step_num=0
TOTAL_STEPS=6
step()    { step_num=$((step_num + 1)); echo ""; echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }
info()    { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
die()     { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }

# ── Paths ────────────────────────────────────────────────────────────
# TUNNELVAULT_INSTALL_ROOT is a DESTDIR-style prefix for the test-suite only:
# file operations happen below it while the generated files keep the real paths.
TV_ROOT="${TUNNELVAULT_INSTALL_ROOT:-}"
SERVICE_NAME="tunnelvault-client"
UPDATER_UNIT="tunnelvault-client-autoupdate"
INSTALL_DIR="/opt/tunnelvault-client"
CONFIG_DIR="/etc/tunnelvault"
CLIENT_ENV="${CONFIG_DIR}/client.env"
SYS_CONFIG="${CONFIG_DIR}/config.json"
UPDATE_CONF="${CONFIG_DIR}/update.conf"
PUBKEY_DEST="${CONFIG_DIR}/release-signing.pub"
SYSTEMD_DIR="/etc/systemd/system"
SUDOERS_FILE="/etc/sudoers.d/tunnelvault-reboot"
CLI_WRAPPER="/usr/local/bin/tunnelvault"
UPDATER_SCRIPT="${INSTALL_DIR}/auto-update-client.sh"
UPDATER_LOG="/var/log/tunnelvault-client-update.log"
# systemd StateDirectory= of the service (TUNNELVAULT_STATE_DIR): reconnect state.json
STATE_DIR_NAME="tunnelvault"
STATE_DIR="/var/lib/${STATE_DIR_NAME}"
# The server's signed updater (install-server.sh) shares update.conf on hosts running both
SERVER_UPDATER_UNIT="tunnelvault-autoupdate"
SERVER_UPDATER_SCRIPT="/opt/tunnelvault/auto-update.sh"
LOCK_FILE="/run/tunnelvault-client-install.lock"
DEFAULT_UPDATE_REPO="TrainABit/ssh-tunnel"
DEFAULT_SCHEDULE="12h"
RESTART_DELAY=30

# fs PATH -> the path on disk (prefixed with TV_ROOT in test mode)
fs() { printf '%s%s' "$TV_ROOT" "$1"; }

# ── Pure validation helpers (unit-tested by sourcing this file) ─────

valid_port() {
  [[ $1 =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$1 <= 65535 ))
}

valid_protocol() {
  [[ $1 == tcp || $1 == http ]]
}

valid_token() {
  [[ $1 =~ ^[A-Za-z0-9]{1,64}$ ]]
}

valid_tunnel_name() {
  [[ $1 =~ ^[A-Za-z0-9._-]{1,64}$ ]]
}

valid_username() {
  [[ $1 =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,31}$ ]]
}

valid_schedule() {
  [[ $1 =~ ^[1-9][0-9]{0,4}(min|h|d)$ ]]
}

# wss:// or ws:// + hostname / IPv4 / [IPv6] + optional :port + optional plain path.
# No userinfo, query string, fragment, spaces or shell/systemd metacharacters.
valid_server_url() {
  local url=$1 hostport port
  local label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
  local host="(${label}(\\.${label})*|\\[[0-9A-Fa-f:.]{2,45}\\])"
  local re="^wss?://${host}(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?\$"
  (( ${#url} <= 255 )) || return 1
  [[ $url =~ $re ]] || return 1
  hostport=${url#*://}
  hostport=${hostport%%/*}
  if [[ $hostport =~ :([0-9]{1,5})$ ]]; then
    port=${BASH_REMATCH[1]}
    valid_port "$port" || return 1
  fi
  return 0
}

# Host part of a validated server URL (lower-case, IPv6 without brackets).
url_host() {
  local h=${1#*://}
  h=${h%%/*}
  if [[ $h == \[* ]]; then
    h=${h#\[}
    h=${h%%\]*}
  else
    h=${h%%:*}
  fi
  printf '%s' "${h,,}"
}

# True for loopback / RFC 1918 / link-local / ULA addresses and local-only names.
is_local_host() {
  local h=${1%.} a b c d
  case "$h" in
    localhost|*.localhost|*.local|*.lan|*.internal|*.home.arpa|::1) return 0 ;;
  esac
  if [[ $h =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
    (( 10#$a <= 255 && 10#$b <= 255 && 10#$c <= 255 && 10#$d <= 255 )) || return 1
    (( 10#$a == 127 || 10#$a == 10 )) && return 0
    (( 10#$a == 172 && 10#$b >= 16 && 10#$b <= 31 )) && return 0
    (( 10#$a == 192 && 10#$b == 168 )) && return 0
    (( 10#$a == 169 && 10#$b == 254 )) && return 0
    return 1
  fi
  if [[ $h =~ ^::ffff:([0-9.]+)$ ]]; then
    is_local_host "${BASH_REMATCH[1]}"
    return
  fi
  if [[ $h == *:* ]]; then
    [[ $h =~ ^f[cd][0-9a-f]{2}: ]] && return 0        # fc00::/7 unique local
    [[ $h =~ ^fe[89ab][0-9a-f]: ]] && return 0        # fe80::/10 link-local
  fi
  return 1
}

# ws:// to a public host = device token and traffic cross the internet unencrypted.
is_insecure_remote_url() {
  [[ $1 == ws://* ]] || return 1
  ! is_local_host "$(url_host "$1")"
}

# --extra-port PORT[:PROTO[:NAME]] -> prints "PORT PROTO NAME"; fails on anything else.
parse_extra_port() {
  local spec=$1 port proto name
  [[ $spec =~ ^([0-9]+)(:([A-Za-z]*)(:(.*))?)?$ ]] || return 1
  port=${BASH_REMATCH[1]}
  proto=${BASH_REMATCH[3]:-tcp}
  proto=${proto,,}
  name=${BASH_REMATCH[5]:-}
  valid_port "$port" || return 1
  valid_protocol "$proto" || return 1
  port=$((10#$port))
  name=${name:-tunnel-${port}}
  valid_tunnel_name "$name" || return 1
  printf '%s %s %s\n' "$port" "$proto" "$name"
}

default_tunnel_name() {
  if [[ $1 == 22 && $2 == tcp ]]; then echo ssh; else echo "tunnel-$1"; fi
}

# ── node helpers (JSON is never built or parsed in shell) ────────────
# Values reach node only through environment variables; the scripts below are
# constants, nothing is interpolated into JavaScript source.

# Reads the existing installation's settings and prints validated KEY=VALUE lines:
# SERVER, TOKEN, TUNNELS_JSON, TUNNELS_INVALID, ALLOW_REBOOT, BASE_JSON, UNIT_USER, WARN.
# Inputs: TV_SYS_CONFIG, TV_USER_CONFIG, TV_CLIENT_ENV, TV_UNIT_FILE.
# shellcheck disable=SC2016  # JavaScript source, not shell
NODE_READ_EXISTING='
"use strict";
const fs = require("fs");
const out = [];
const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
const warn = (m) => out.push("WARN=" + clean(m));
const TOKEN_RE = /^[A-Za-z0-9]{1,64}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
function readText(p) {
  if (!p) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) { warn("ignoring " + p + " (not a regular file)"); return null; }
    if (st.size > 1024 * 1024) { warn("ignoring " + p + " (too large)"); return null; }
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") warn("cannot read " + p + " (" + (e.code || "error") + ")");
    return null;
  }
}
function readJson(p) {
  const t = readText(p);
  if (t === null) return null;
  try {
    const d = JSON.parse(t);
    if (d && typeof d === "object" && !Array.isArray(d)) return d;
  } catch { /* fallthrough */ }
  warn("ignoring " + p + " (invalid JSON)");
  return null;
}
function readEnvFile(p) {
  const t = readText(p);
  const env = {};
  if (t === null) return env;
  for (const raw of t.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v[0] === "\"" && v.endsWith("\"")) || (v[0] === "\x27" && v.endsWith("\x27")))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
// Legacy values: map http(s) to ws(s), drop credentials/query/fragment.
function normServer(v, from) {
  if (typeof v !== "string" || !v.trim()) return null;
  let u;
  try { u = new URL(v.trim()); } catch { warn("ignoring invalid server URL in " + from); return null; }
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  if (u.protocol !== "ws:" && u.protocol !== "wss:") { warn("ignoring server URL with unsupported scheme in " + from); return null; }
  const qToken = u.searchParams.get("auth_token");
  if (u.search || u.hash || u.username || u.password) warn("removed credentials/query string from the server URL found in " + from);
  u.username = ""; u.password = ""; u.search = ""; u.hash = "";
  let s = u.toString();
  if (u.pathname === "/") s = s.replace(/\/$/, "");
  return { server: s, qToken };
}
const sys = readJson(process.env.TV_SYS_CONFIG);
const usr = readJson(process.env.TV_USER_CONFIG);
const env = readEnvFile(process.env.TV_CLIENT_ENV);
const unitText = readText(process.env.TV_UNIT_FILE) || "";
const unit = {};
for (const line of unitText.split(/\r?\n/)) {
  let m = /^\s*User\s*=\s*(\S+)\s*$/.exec(line);
  if (m) unit.user = m[1];
  if (/^\s*ExecStart\s*=/.test(line)) {
    m = /\s--server[= ]+(\S+)/.exec(line);
    if (m) unit.server = m[1];
    m = /\s--auth-token[= ]+(\S+)/.exec(line);
    if (m) unit.token = m[1];
  }
}
let server = "";
let qToken = null;
for (const [v, from] of [
  [env.TUNNELVAULT_SERVER, "client.env"], [sys && sys.server, "/etc/tunnelvault/config.json"],
  [usr && usr.server, "the user config.json"], [unit.server, "the old service unit"],
]) {
  const n = normServer(v, from);
  if (n) { server = n.server; qToken = n.qToken; break; }
}
let token = "";
for (const [v, from] of [
  [env.TUNNELVAULT_AUTH_TOKEN, "client.env"], [sys && sys.auth_token, "/etc/tunnelvault/config.json"],
  [usr && usr.auth_token, "the user config.json"], [unit.token, "the old service unit"], [qToken, "the server URL"],
]) {
  if (typeof v !== "string" || v === "") continue;
  if (TOKEN_RE.test(v)) { token = v; break; }
  warn("ignoring invalid token found in " + from);
}
let tunnelsJson = "";
let tunnelsInvalid = false;
const src = sys && Array.isArray(sys.tunnels) && sys.tunnels.length ? sys : (usr && Array.isArray(usr.tunnels) && usr.tunnels.length ? usr : null);
if (src) {
  const seen = new Set();
  const tunnels = [];
  for (const t of src.tunnels) {
    const port = t && Number(t.port);
    const protocol = t && String(t.protocol || "tcp").toLowerCase();
    if (!t || typeof t !== "object" || !Number.isInteger(port) || port < 1 || port > 65535
        || (protocol !== "tcp" && protocol !== "http") || seen.has(port)) { tunnelsInvalid = true; break; }
    seen.add(port);
    const e = { port, protocol, name: typeof t.name === "string" && t.name ? t.name.slice(0, 100) : "tunnel-" + port };
    if (typeof t.subdomain === "string" && t.subdomain) e.subdomain = t.subdomain.slice(0, 63);
    tunnels.push(e);
  }
  if (!tunnelsInvalid) tunnelsJson = JSON.stringify(tunnels);
}
const base = {};
const baseSrc = sys || usr || {};
for (const [k, v] of Object.entries(baseSrc)) {
  if (["auth_token", "server", "tunnels", "allow_reboot"].includes(k)) continue;
  base[k] = v;
}
out.push("SERVER=" + server);
out.push("TOKEN=" + token);
out.push("TUNNELS_JSON=" + tunnelsJson);
out.push("TUNNELS_INVALID=" + (tunnelsInvalid ? "1" : "0"));
// Remote reboot: TUNNELVAULT_ALLOW_REBOOT in client.env wins (as in the client), else the
// root-owned /etc config.json. The user-writable copy is never trusted for it.
let allowReboot = Boolean(sys && sys.allow_reboot === true);
const envReboot = typeof env.TUNNELVAULT_ALLOW_REBOOT === "string" ? env.TUNNELVAULT_ALLOW_REBOOT.trim() : "";
if (/^(1|true|yes|on)$/i.test(envReboot)) allowReboot = true;
else if (/^(0|false|no|off)$/i.test(envReboot)) allowReboot = false;
out.push("ALLOW_REBOOT=" + (allowReboot ? "true" : "false"));
out.push("BASE_JSON=" + JSON.stringify(base));
out.push("UNIT_USER=" + (unit.user && USER_RE.test(unit.user) ? unit.user : ""));
process.stdout.write(out.join("\n") + "\n");
'

# Builds config.json (no token). Inputs: TV_SERVER, TV_ALLOW_REBOOT (true|false),
# TV_TUNNELS_JSON (preserved tunnels) or TV_TUNNEL_SPECS ("port proto name" lines),
# TV_BASE_JSON (other preserved top-level keys).
# shellcheck disable=SC2016  # JavaScript source, not shell
NODE_BUILD_CONFIG='
"use strict";
const fail = (m) => { process.stderr.write(m + "\n"); process.exit(1); };
const server = process.env.TV_SERVER || "";
if (!/^wss?:\/\/[A-Za-z0-9.:\[\]-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(server)) fail("invalid server URL");
let tunnels;
if (process.env.TV_TUNNEL_SPECS) {
  tunnels = process.env.TV_TUNNEL_SPECS.split("\n").filter(Boolean).map((line) => {
    const [port, protocol, name] = line.split(" ");
    return { port: Number(port), protocol, name };
  });
} else {
  try { tunnels = JSON.parse(process.env.TV_TUNNELS_JSON || ""); } catch { fail("invalid tunnels JSON"); }
}
if (!Array.isArray(tunnels) || tunnels.length === 0) fail("no tunnels configured");
const seen = new Set();
for (const t of tunnels) {
  if (!t || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535) fail("invalid tunnel port");
  if (t.protocol !== "tcp" && t.protocol !== "http") fail("invalid tunnel protocol");
  if (typeof t.name !== "string" || !t.name || t.name.length > 100) fail("invalid tunnel name");
  if (seen.has(t.port)) fail("duplicate tunnel port " + t.port);
  seen.add(t.port);
}
let base = {};
try { base = JSON.parse(process.env.TV_BASE_JSON || "{}") || {}; } catch { base = {}; }
if (typeof base !== "object" || Array.isArray(base)) base = {};
for (const k of ["auth_token", "server", "tunnels", "allow_reboot"]) delete base[k];
const cfg = { server, tunnels, allow_reboot: process.env.TV_ALLOW_REBOOT === "true", ...base };
process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
'

# Prints "port/proto (name)" per tunnel for the summary. Input: TV_TUNNELS_JSON.
# shellcheck disable=SC2016  # JavaScript source, not shell
NODE_DESCRIBE_TUNNELS='
const t = JSON.parse(process.env.TV_TUNNELS_JSON || "[]");
process.stdout.write(t.map((x) => x.port + "/" + x.protocol + " (" + String(x.name).replace(/[^\x20-\x7e]/g, "?") + ")").join(", "));
'

# Parses KEY=VALUE files such as update.conf (never sourced). Prints the value of KEY.
conf_value() {
  local file=$1 want=$2 line key value result=""
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value="${value%"${value##*[![:space:]]}"}"
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    if [[ $key == "$want" ]]; then result=$value; fi
  done < "$file"
  printf '%s' "$result"
}

# ── Generated file contents (pure; unit-tested) ─────────────────────

render_client_env() {
  printf '# TunnelVault client credentials — managed by install-client.sh (mode 0600, root only).\n'
  printf '# Read by systemd (EnvironmentFile=) so the token never appears in process arguments.\n'
  printf 'TUNNELVAULT_SERVER=%s\n' "$SERVER_URL"
  printf 'TUNNELVAULT_AUTH_TOKEN=%s\n' "$AUTH_TOKEN"
  printf '# Remote reboot from the dashboard (1/0). Change it with install-client.sh --allow-reboot /\n'
  printf '# --no-reboot, which also manages the sudoers rule and the service hardening.\n'
  printf 'TUNNELVAULT_ALLOW_REBOOT=%s\n' "$([[ $ALLOW_REBOOT == true ]] && echo 1 || echo 0)"
}

render_sudoers() {
  printf '# TunnelVault: lets the client service user reboot this device when the\n'
  printf '# dashboard asks (installed by install-client.sh --allow-reboot; remove with --no-reboot).\n'
  printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /bin/systemctl reboot, /usr/sbin/reboot "", /sbin/reboot ""\n' "$SERVICE_USER"
}

render_service_unit() {
  cat <<EOF
[Unit]
Description=TunnelVault client (device tunnel)
Documentation=https://github.com/${DEFAULT_UPDATE_REPO}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
# Server URL, device token and the remote-reboot switch (0600 root) — never on the command line.
EnvironmentFile=${CLIENT_ENV}
Environment=NODE_ENV=production
# Settings written by install-client.sh (no token; root-owned, readable by the service group).
Environment=TUNNELVAULT_CONFIG=${SYS_CONFIG}
# Reconnect state (tunnel ids + owner secrets that keep this device's public ports stable).
Environment=TUNNELVAULT_STATE_DIR=${STATE_DIR}
StateDirectory=${STATE_DIR_NAME}
StateDirectoryMode=0700
ExecStart=${CLI_WRAPPER} connect
Restart=always
RestartSec=10
SyslogIdentifier=tunnelvault-client
UMask=0077

# Hardening. The client only needs outbound network access, its config and
# ${STATE_DIR} (always writable: StateDirectory=).
PrivateTmp=yes
ProtectHome=read-only
ProtectControlGroups=yes
EOF
  if [[ $ALLOW_REBOOT == true ]]; then
    cat <<EOF
# Remote reboot is enabled (--allow-reboot): the service runs 'sudo -n systemctl reboot'.
# For a non-root service every seccomp-based option (SystemCallFilter/-Architectures,
# RestrictAddressFamilies/Namespaces/Realtime/SUIDSGID, ProtectKernel*, ProtectClock,
# ProtectHostname, PrivateDevices, LockPersonality, ...) implies NoNewPrivileges=yes,
# which makes sudo fail — so only mount-namespace protections are used here.
ProtectSystem=full
EOF
  else
    cat <<EOF
ProtectSystem=strict
NoNewPrivileges=yes
RestrictSUIDSGID=yes
PrivateDevices=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectHostname=yes
ProtectClock=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
EOF
  fi
  cat <<EOF

[Install]
WantedBy=multi-user.target
EOF
}

render_updater_service() {
  cat <<EOF
[Unit]
Description=TunnelVault client auto-updater (signed GitHub releases)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${UPDATER_SCRIPT}
SyslogIdentifier=${UPDATER_UNIT}
TimeoutStartSec=1h
Nice=10
IOSchedulingClass=idle
PrivateTmp=yes
EOF
}

render_updater_timer() {
  cat <<EOF
[Unit]
Description=TunnelVault client auto-update timer

[Timer]
OnBootSec=15min
OnUnitActiveSec=${UPDATE_SCHEDULE}
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

render_update_conf() {
  cat <<EOF
# TunnelVault auto-update settings (read by auto-update-client.sh / auto-update.sh).
# Releases are installed only if SHA256SUMS.sig verifies with PUBKEY and the
# tarball matches SHA256SUMS; downgrades are refused.
ENABLED=${UPDATE_ENABLED}
SCHEDULE=${UPDATE_SCHEDULE}
UPDATE_REPO=${UPDATE_REPO}
PINNED_VERSION=${PINNED_VERSION}
PUBKEY=${PUBKEY_DEST}
EOF
}

# ── Argument parsing ─────────────────────────────────────────────────

OPT_SERVER=""
OPT_TOKEN=""
OPT_TOKEN_FILE=""
OPT_PORT=""
OPT_PROTOCOL=""
OPT_USER=""
OPT_REBOOT=""        # allow | deny | ""
OPT_AUTO_UPDATE=""   # enable | disable | ""
OPT_PUBKEY=""
UPGRADE=false
EXTRA_PORTS=()

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

need_value() {
  [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value (see --help)"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server)         need_value "$@"; OPT_SERVER=$2; shift 2 ;;
      --token)          need_value "$@"; OPT_TOKEN=$2; shift 2 ;;
      --token-file)     need_value "$@"; OPT_TOKEN_FILE=$2; shift 2 ;;
      --port)           need_value "$@"; OPT_PORT=$2; shift 2 ;;
      --protocol)       need_value "$@"; OPT_PROTOCOL=${2,,}; shift 2 ;;
      --user)           need_value "$@"; OPT_USER=$2; shift 2 ;;
      --extra-port)     need_value "$@"; EXTRA_PORTS+=("$2"); shift 2 ;;
      --release-pubkey) need_value "$@"; OPT_PUBKEY=$2; shift 2 ;;
      --allow-reboot)
        [[ $OPT_REBOOT != deny ]] || die "--allow-reboot and --no-reboot are mutually exclusive"
        OPT_REBOOT=allow; shift ;;
      --no-reboot)
        [[ $OPT_REBOOT != allow ]] || die "--allow-reboot and --no-reboot are mutually exclusive"
        OPT_REBOOT=deny; shift ;;
      --auto-update)
        [[ $OPT_AUTO_UPDATE != disable ]] || die "--auto-update and --no-auto-update are mutually exclusive"
        OPT_AUTO_UPDATE=enable; shift ;;
      --no-auto-update)
        [[ $OPT_AUTO_UPDATE != enable ]] || die "--auto-update and --no-auto-update are mutually exclusive"
        OPT_AUTO_UPDATE=disable; shift ;;
      --upgrade)        UPGRADE=true; shift ;;
      --yes|-y)         shift ;;
      -h|--help)        usage; exit 0 ;;
      *) die "Unknown option: $(printf '%q' "$1") (see --help)" ;;
    esac
  done
}

ALLOW_REBOOT=false   # resolved by resolve_settings

# Validates everything that can be checked before touching the system.
# Builds TUNNEL_SPECS (lines "port proto name") when tunnels are given on the command line.
TUNNEL_SPECS=""
TUNNELS_FROM_ARGS=false
validate_args() {
  local spec parsed main_port main_proto seen=" " p
  if [[ -n $OPT_TOKEN_FILE ]]; then
    [[ -z $OPT_TOKEN ]] || die "use either --token or --token-file"
    [[ -f $OPT_TOKEN_FILE && -r $OPT_TOKEN_FILE ]] || die "--token-file: cannot read $(printf '%q' "$OPT_TOKEN_FILE")"
    IFS= read -r OPT_TOKEN < "$OPT_TOKEN_FILE" || true
    OPT_TOKEN=${OPT_TOKEN%$'\r'}
    [[ -n $OPT_TOKEN ]] || die "--token-file is empty"
  fi
  if [[ -n $OPT_SERVER ]]; then
    valid_server_url "$OPT_SERVER" \
      || die "--server must be wss://HOST[:PORT][/PATH] or ws://HOST[:PORT][/PATH] (no credentials, query string or spaces)"
  fi
  if [[ -n $OPT_TOKEN ]]; then
    valid_token "$OPT_TOKEN" || die "--token must be 1-64 letters and digits (copy it from the dashboard)"
  fi
  if [[ -n $OPT_USER ]]; then
    valid_username "$OPT_USER" || die "--user: invalid user name"
  fi
  if [[ -n $OPT_PUBKEY ]]; then
    [[ -f $OPT_PUBKEY && -r $OPT_PUBKEY ]] || die "--release-pubkey: file not found"
  fi
  if [[ -n $OPT_PROTOCOL ]]; then
    valid_protocol "$OPT_PROTOCOL" || die "--protocol must be tcp or http"
    [[ -n $OPT_PORT ]] || ! $UPGRADE || die "--protocol needs --port when used with --upgrade"
  fi
  if [[ -n $OPT_PORT ]]; then
    valid_port "$OPT_PORT" || die "--port must be a number between 1 and 65535"
  fi

  if [[ -n $OPT_PORT || ${#EXTRA_PORTS[@]} -gt 0 ]] || ! $UPGRADE; then
    TUNNELS_FROM_ARGS=true
    main_port=$((10#${OPT_PORT:-22}))
    main_proto=${OPT_PROTOCOL:-tcp}
    TUNNEL_SPECS="${main_port} ${main_proto} $(default_tunnel_name "$main_port" "$main_proto")"
    seen+="${main_port} "
    for spec in ${EXTRA_PORTS[@]+"${EXTRA_PORTS[@]}"}; do
      parsed=$(parse_extra_port "$spec") \
        || die "--extra-port $(printf '%q' "$spec"): expected PORT:PROTO:NAME (PORT 1-65535, PROTO tcp|http, NAME [A-Za-z0-9._-]{1,64})"
      p=${parsed%% *}
      [[ $seen != *" ${p} "* ]] || die "--extra-port: port ${p} is configured twice"
      seen+="${p} "
      TUNNEL_SPECS+=$'\n'"${parsed}"
    done
  fi
}

# ── System steps ─────────────────────────────────────────────────────

node_major() {
  local v
  v=$(node -v 2>/dev/null) || return 1
  v=${v#v}
  v=${v%%.*}
  [[ $v =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$v"
}

install_nodesource_22() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt-get update failed"
  apt-get install -y -qq ca-certificates curl gnupg > /dev/null || die "could not install curl/gnupg"
  install -d -m 0755 /etc/apt/keyrings
  curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg \
    || die "could not download the NodeSource signing key"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq || die "apt-get update failed (NodeSource)"
  apt-get install -y -qq nodejs > /dev/null || die "apt-get install nodejs failed"
}

# Node.js >= 20 is required; installs 22.x from NodeSource when missing or older.
# A newer Node.js is never replaced.
ensure_node() {
  local major=""
  if major=$(node_major) && (( major >= 20 )); then
    info "Node.js $(node -v) found"
    return 0
  fi
  if [[ -n $major ]]; then
    warn "Node.js v${major} is too old (need >= 20) — installing Node.js 22.x"
  else
    info "Node.js not found — installing Node.js 22.x"
  fi
  [[ -z $TV_ROOT ]] || die "test mode: Node.js >= 20 must already be installed"
  command -v apt-get >/dev/null 2>&1 \
    || die "Node.js >= 20 is required. Install Node.js 22 LTS (https://nodejs.org/) and re-run this installer."
  install_nodesource_22
  major=$(node_major) || die "node is still not available after installation"
  (( major >= 20 )) || die "node on PATH is still v${major} ($(command -v node)); remove the old Node.js and re-run"
  info "Node.js $(node -v) installed"
}

# Runs a command as the service user (never as root inside a user-owned directory).
as_service_user() {
  if [[ $SERVICE_USER == root ]]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_GROUP" --init-groups -- "$@"
  else
    sudo -n -u "$SERVICE_USER" -- "$@"
  fi
}

# Creates DIR (mode 0755, root) only if it is missing — never re-modes system dirs.
ensure_dir() {
  [[ -d $1 ]] || install -d -m 0755 -o root -g root "$1"
}

# Writes CONTENT (stdin) to FILE atomically with MODE, owned by root (group GROUP, default root).
write_root_file() {
  local file=$1 mode=$2 group=${3:-root} tmp
  tmp=$(mktemp "$(dirname -- "$file")/.$(basename -- "$file").XXXXXX")
  cat > "$tmp"
  chown "root:${group}" -- "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -- "$tmp" "$file"
}

load_existing_settings() {
  local line key value
  EX_SERVER=""; EX_TOKEN=""; EX_TUNNELS_JSON=""; EX_TUNNELS_INVALID=0
  EX_ALLOW_REBOOT=false; EX_BASE_JSON="{}"; EX_UNIT_USER=""
  while IFS= read -r line; do
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      SERVER) EX_SERVER=$value ;;
      TOKEN) EX_TOKEN=$value ;;
      TUNNELS_JSON) EX_TUNNELS_JSON=$value ;;
      TUNNELS_INVALID) EX_TUNNELS_INVALID=$value ;;
      ALLOW_REBOOT) EX_ALLOW_REBOOT=$value ;;
      BASE_JSON) EX_BASE_JSON=$value ;;
      UNIT_USER) EX_UNIT_USER=$value ;;
      WARN) [[ ${2:-} == quiet ]] || warn "$value" ;;
    esac
  done < <(TV_SYS_CONFIG="$(fs "$SYS_CONFIG")" \
           TV_USER_CONFIG="${1:-}" \
           TV_CLIENT_ENV="$(fs "$CLIENT_ENV")" \
           TV_UNIT_FILE="$(fs "${SYSTEMD_DIR}/${SERVICE_NAME}.service")" \
           node -e "$NODE_READ_EXISTING" || echo "WARN=could not read the existing configuration")
}

resolve_settings() {
  local legacy_user_config="" home
  if $UPGRADE && [[ ! -d $(fs "$INSTALL_DIR") && ! -f $(fs "$SYS_CONFIG") && ! -f $(fs "$CLIENT_ENV") ]]; then
    warn "No existing installation found — performing a fresh install"
    UPGRADE=false
  fi

  # Service user: --user > existing unit (upgrade) > sudo user.
  load_existing_settings "" quiet
  if [[ -n $OPT_USER ]]; then
    SERVICE_USER=$OPT_USER
  elif $UPGRADE && [[ -n $EX_UNIT_USER ]]; then
    SERVICE_USER=$EX_UNIT_USER
  elif [[ ${TUNNELVAULT_UPDATER:-} == 1 ]]; then
    die "cannot determine the service user (${SYSTEMD_DIR}/${SERVICE_NAME}.service missing) — re-run the installer manually with --user"
  else
    SERVICE_USER=${SUDO_USER:-${USER:-root}}
  fi
  valid_username "$SERVICE_USER" || die "invalid service user name"
  id -u "$SERVICE_USER" >/dev/null 2>&1 || die "user '$SERVICE_USER' does not exist (use --user)"
  SERVICE_GROUP=$(id -gn "$SERVICE_USER") || die "cannot determine the group of $SERVICE_USER"
  valid_username "$SERVICE_GROUP" || die "unsupported group name for $SERVICE_USER"
  # The service itself needs no home directory (config in /etc, state in STATE_DIR); an
  # existing one gets a copy of config.json for the CLI and is checked for legacy files.
  home=$(getent passwd "$SERVICE_USER" | cut -d: -f6 || true)
  USER_HOME=""
  if [[ $home =~ ^/[A-Za-z0-9._/-]*$ && $home != *..* && -n ${home%/} && -d $(fs "${home%/}") ]]; then
    USER_HOME=${home%/}
  else
    warn "${SERVICE_USER} has no usable home directory ($(printf '%q' "$home")) — skipping ~/.tunnelvault (the service does not need it)"
  fi
  [[ $SERVICE_USER != root ]] || warn "The client service will run as root — consider --user <unprivileged user>"

  # Legacy installs may only have the user's copy of config.json.
  if [[ -n $USER_HOME ]]; then
    legacy_user_config="$(fs "$USER_HOME")/.tunnelvault/config.json"
    if [[ -L $(dirname -- "$legacy_user_config") || -L $legacy_user_config ]]; then legacy_user_config=""; fi
  fi
  load_existing_settings "$legacy_user_config"

  if $UPGRADE; then
    SERVER_URL=${OPT_SERVER:-$EX_SERVER}
    AUTH_TOKEN=${OPT_TOKEN:-$EX_TOKEN}
    [[ -n $SERVER_URL ]] || die "Could not read the server URL from the existing configuration — pass --server"
    [[ -n $AUTH_TOKEN ]] || die "Could not read the device token from the existing configuration — pass --token"
  else
    SERVER_URL=$OPT_SERVER
    AUTH_TOKEN=$OPT_TOKEN
    [[ -n $SERVER_URL ]] || die "--server is required (e.g. wss://tunnel.example.com)"
    [[ -n $AUTH_TOKEN ]] || die "--token is required (create one in the dashboard under Tokens)"
  fi
  valid_server_url "$SERVER_URL" || die "The server URL $(printf '%q' "$SERVER_URL") is invalid — pass --server"
  valid_token "$AUTH_TOKEN" || die "The device token is invalid — pass --token"

  if $TUNNELS_FROM_ARGS; then
    TUNNELS_JSON=""
  elif [[ $EX_TUNNELS_INVALID == 1 ]]; then
    die "The existing tunnels[] configuration is invalid — pass --port (and --extra-port) to replace it"
  elif [[ -n $EX_TUNNELS_JSON ]]; then
    TUNNELS_JSON=$EX_TUNNELS_JSON
  else
    TUNNELS_FROM_ARGS=true
    TUNNEL_SPECS="22 tcp ssh"
  fi

  case "$OPT_REBOOT" in
    allow) ALLOW_REBOOT=true ;;
    deny)  ALLOW_REBOOT=false ;;
    *)     if $UPGRADE; then ALLOW_REBOOT=$EX_ALLOW_REBOOT; else ALLOW_REBOOT=false; fi ;;
  esac
  [[ $ALLOW_REBOOT == true ]] || ALLOW_REBOOT=false
  BASE_JSON=$EX_BASE_JSON

  info "Service user: ${SERVICE_USER} (home ${USER_HOME:-none})"
  info "Server: ${SERVER_URL}"
  if $TUNNELS_FROM_ARGS; then info "Tunnels: from the command line"; else info "Tunnels: kept from the existing configuration"; fi
  info "Remote reboot: $([[ $ALLOW_REBOOT == true ]] && echo enabled || echo disabled)"
}

build_config_json() {
  if $TUNNELS_FROM_ARGS; then
    TV_SERVER="$SERVER_URL" TV_ALLOW_REBOOT="$ALLOW_REBOOT" TV_TUNNEL_SPECS="$TUNNEL_SPECS" \
      TV_TUNNELS_JSON="" TV_BASE_JSON="$BASE_JSON" node -e "$NODE_BUILD_CONFIG"
  else
    TV_SERVER="$SERVER_URL" TV_ALLOW_REBOOT="$ALLOW_REBOOT" TV_TUNNEL_SPECS="" \
      TV_TUNNELS_JSON="$TUNNELS_JSON" TV_BASE_JSON="$BASE_JSON" node -e "$NODE_BUILD_CONFIG"
  fi
}

tree_version() {
  local v=""
  if [[ -f "${SCRIPT_DIR}/VERSION" ]]; then
    v=$(head -c 64 -- "${SCRIPT_DIR}/VERSION" | tr -d '[:space:]')
  fi
  if [[ $v =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]]; then printf '%s' "$v"; else printf 'dev'; fi
}

# Stages the new code next to the live one, installs dependencies there and
# swaps directories, so a failed npm run never leaves a broken client behind
# (also safe while the tunnel carries the SSH session running this installer).
install_client_files() {
  local live stage prev node_bin
  live=$(fs "$INSTALL_DIR")
  stage="${live}.new"
  prev="${live}.previous"
  ensure_dir "$(dirname -- "$live")"
  rm -rf -- "$stage"
  install -d -m 0755 -o root -g root "$stage"
  tar -C "${SCRIPT_DIR}/client" --exclude=./node_modules --exclude=./test -cf - . \
    | tar -C "$stage" --no-same-owner -xf - \
    || { rm -rf -- "$stage"; die "copying the client files failed"; }
  [[ -f "${stage}/bin/tunnelvault.js" ]] || die "client/bin/tunnelvault.js missing in the source tree"

  if [[ -d "${live}/node_modules" && -f "${live}/package-lock.json" && -f "${stage}/package-lock.json" ]] \
      && cmp -s "${stage}/package.json" "${live}/package.json" \
      && cmp -s "${stage}/package-lock.json" "${live}/package-lock.json"; then
    cp -a -- "${live}/node_modules" "${stage}/node_modules"
    info "Dependencies unchanged — reused node_modules"
  else
    echo -e "  ${DIM}Installing dependencies (npm ci --omit=dev)...${NC}"
    if [[ -f "${stage}/package-lock.json" ]]; then
      ( cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund ) \
        || { rm -rf -- "$stage"; die "npm ci failed — the installed client was not changed"; }
    else
      warn "client/package-lock.json missing — falling back to npm install"
      ( cd "$stage" && npm install --omit=dev --ignore-scripts --no-audit --no-fund ) \
        || { rm -rf -- "$stage"; die "npm install failed — the installed client was not changed"; }
    fi
    info "Dependencies installed"
  fi

  printf '%s\n' "$(tree_version)" > "${stage}/VERSION"
  if [[ $AUTO_UPDATE == true ]]; then
    install -m 0755 -o root -g root "${SCRIPT_DIR}/auto-update-client.sh" "${stage}/auto-update-client.sh"
  fi
  chown -R root:root -- "$stage"
  chmod -R u+rwX,go+rX,go-w -- "$stage"
  chmod 0755 -- "${stage}/bin/tunnelvault.js"

  if [[ -d $live ]]; then
    rm -rf -- "$prev"
    mv -- "$live" "$prev"
  fi
  mv -- "$stage" "$live"
  info "Client $(tree_version) installed to ${INSTALL_DIR}${TV_ROOT:+ (under ${TV_ROOT})}"

  node_bin=$(command -v node)
  case "$node_bin" in
    /usr/*|/bin/*|/opt/*|/snap/*) ;;
    *) warn "node is at ${node_bin}, which the service user may not be able to run"; node_bin=node ;;
  esac
  ensure_dir "$(dirname -- "$(fs "$CLI_WRAPPER")")"
  # shellcheck disable=SC2016  # "$@" belongs to the generated wrapper
  printf '#!/bin/sh\nexec %s %s/bin/tunnelvault.js "$@"\n' "$node_bin" "$INSTALL_DIR" \
    | write_root_file "$(fs "$CLI_WRAPPER")" 0755
  info "CLI wrapper: ${CLI_WRAPPER}"
}

# /etc/tunnelvault: root-owned and never group/world-writable (the updaters refuse anything
# else); 0755 so the service user can read config.json and the server's backend update.conf.
# Secrets in there carry their own mode (client.env 0600).
prepare_config_dir() {
  local dir
  dir=$(fs "$CONFIG_DIR")
  [[ ! -L $dir ]] || die "${CONFIG_DIR} is a symlink — refusing to write secrets through it"
  [[ ! -e $dir || -d $dir ]] || die "${CONFIG_DIR} exists and is not a directory"
  if [[ ! -d $dir ]]; then
    install -d -m 0755 -o root -g root "$dir"
  else
    chown root:root -- "$dir"
    chmod 0755 -- "$dir"
  fi
}

write_user_config() {
  local src=$1 home dir owner
  home=$(fs "$USER_HOME")
  dir="${home}/.tunnelvault"
  [[ ! -L $dir ]] || die "${USER_HOME}/.tunnelvault is a symlink — refusing"
  [[ ! -e $dir || -d $dir ]] || die "${USER_HOME}/.tunnelvault exists and is not a directory"
  if [[ ! -d $dir ]]; then
    if ! as_service_user mkdir -m 0700 -- "$dir" 2>/dev/null; then
      # The home is not writable by the user (system account): create it as root,
      # which is safe only while the user cannot modify the parent directory.
      owner=$(stat -c '%u' -- "$home")
      [[ $owner == 0 && $(( 8#$(stat -c '%a' -- "$home") & 8#022 )) == 0 ]] \
        || die "cannot create ${USER_HOME}/.tunnelvault as ${SERVICE_USER}"
      install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$dir"
    fi
  elif [[ $(stat -c '%U' -- "$dir") != "$SERVICE_USER" ]]; then
    chown -h "${SERVICE_USER}:${SERVICE_GROUP}" -- "$dir"
  fi
  # Everything inside the user's directory is done with the user's privileges.
  # shellcheck disable=SC2016  # $1 is expanded by the inner sh
  as_service_user /bin/sh -c '
    umask 077
    chmod 700 "$1" || exit 1
    tmp=$(mktemp "$1/.config.json.XXXXXX") || exit 1
    cat > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$1/config.json" || { rm -f "$tmp"; exit 1; }
    if [ -f "$1/state.json" ] && [ ! -L "$1/state.json" ]; then
      chmod 600 "$1/state.json" 2>/dev/null \
        || echo "  ⚠ could not chmod 600 $1/state.json (not owned by the service user?)" >&2
    fi
    exit 0
  ' sh "$dir" < "$src" || die "could not write ${USER_HOME}/.tunnelvault/config.json"
}

CLEANUP_DIRS=()
# shellcheck disable=SC2317,SC2329  # invoked via trap (SC2317: shellcheck < 0.10)
cleanup() {
  local d
  for d in ${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}; do rm -rf -- "$d"; done
}

write_configs() {
  local work
  prepare_config_dir
  work=$(mktemp -d)
  CLEANUP_DIRS+=("$work")
  build_config_json > "${work}/config.json" || die "could not build config.json"

  render_client_env | write_root_file "$(fs "$CLIENT_ENV")" 0600
  info "Credentials: ${CLIENT_ENV} (0600, root only)"
  write_root_file "$(fs "$SYS_CONFIG")" 0640 "$SERVICE_GROUP" < "${work}/config.json"
  info "Config: ${SYS_CONFIG} (root:${SERVICE_GROUP} 0640, no token — read by the service)"
  if [[ -n $USER_HOME ]]; then
    write_user_config "${work}/config.json"
    info "Config: ${USER_HOME}/.tunnelvault/config.json (0600, owned by ${SERVICE_USER}; copy for the CLI)"
  fi
  prepare_state_dir
}

# Reconnect state (tunnel ids + owner secrets that keep the device's public ports) lives in
# STATE_DIR (systemd StateDirectory=, owned by the service user). Older installs kept it in
# ~SERVICE_USER/.tunnelvault/state.json: it is copied once so the device keeps its ports.
prepare_state_dir() {
  local dir legacy
  dir=$(fs "$STATE_DIR")
  if [[ -L $dir || ( -e $dir && ! -d $dir ) ]]; then
    die "${STATE_DIR} is a symlink or not a directory — refusing"
  fi
  if [[ ! -d $dir ]]; then
    ensure_dir "$(dirname -- "$dir")"
    install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$dir"
  elif [[ $(stat -c '%U' -- "$dir") != "$SERVICE_USER" ]]; then
    # Left to systemd: StateDirectory= re-owns the whole tree (safely) at the next start.
    info "State: ${STATE_DIR} (handed over to ${SERVICE_USER} by systemd at the next start)"
    return 0
  fi
  if [[ -e "${dir}/state.json" || -L "${dir}/state.json" || -z $USER_HOME ]]; then
    info "State: ${STATE_DIR} (0700, owned by ${SERVICE_USER})"
    return 0
  fi
  legacy="$(fs "$USER_HOME")/.tunnelvault/state.json"
  if [[ ! -f $legacy || -L $legacy || -L $(dirname -- "$legacy") ]]; then
    info "State: ${STATE_DIR} (0700, owned by ${SERVICE_USER})"
    return 0
  fi
  # Copied with the service user's own privileges: root never reads a file the user controls.
  # shellcheck disable=SC2016  # $1/$2 are expanded by the inner sh
  if as_service_user /bin/sh -c '
      umask 077
      tmp=$(mktemp "$2/.state.json.XXXXXX") || exit 1
      if head -c 1048576 -- "$1" > "$tmp" && [ ! -e "$2/state.json" ] && mv -f -- "$tmp" "$2/state.json"; then
        exit 0
      fi
      rm -f -- "$tmp"
      exit 1
    ' sh "$legacy" "$dir"; then
    info "Reconnect state migrated: ${USER_HOME}/.tunnelvault/state.json -> ${STATE_DIR}/state.json (public ports stay the same)"
  else
    warn "Could not copy ${USER_HOME}/.tunnelvault/state.json to ${STATE_DIR} — the device may get new public ports"
  fi
}

configure_reboot() {
  local sudoers_dir tmp file
  file=$(fs "$SUDOERS_FILE")
  sudoers_dir=$(dirname -- "$file")
  if [[ $ALLOW_REBOOT == true && $SERVICE_USER != root ]]; then
    if [[ ! -d $sudoers_dir ]] || ! command -v sudo >/dev/null 2>&1; then
      warn "sudo is not installed — remote reboot cannot work while the service runs as ${SERVICE_USER}"
      return 0
    fi
    # A name containing '.' is ignored by sudo's @includedir until it is renamed.
    tmp=$(mktemp "${sudoers_dir}/.tunnelvault-reboot.XXXXXX")
    render_sudoers > "$tmp"
    chown root:root -- "$tmp"
    chmod 0440 -- "$tmp"
    if command -v visudo >/dev/null 2>&1 && ! visudo -c -q -f "$tmp" >/dev/null 2>&1; then
      rm -f -- "$tmp"
      die "the generated sudoers rule failed visudo validation"
    fi
    mv -f -- "$tmp" "$file"
    info "Remote reboot enabled (sudoers: ${SUDOERS_FILE})"
  elif [[ $ALLOW_REBOOT == true ]]; then
    rm -f -- "$file"
    info "Remote reboot enabled (service runs as root)"
  else
    if [[ -e $file || -L $file ]]; then
      rm -f -- "$file"
      info "Remote reboot disabled — removed ${SUDOERS_FILE}"
    else
      info "Remote reboot disabled (enable with --allow-reboot)"
    fi
  fi
}

write_service_unit() {
  render_service_unit | write_root_file "$(fs "${SYSTEMD_DIR}/${SERVICE_NAME}.service")" 0644
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || systemctl enable "$SERVICE_NAME"
  info "Service ${SERVICE_NAME}.service written (EnvironmentFile, no secrets in ExecStart)"
}

# Decides AUTO_UPDATE (true|false) and the key source before files are staged.
AUTO_UPDATE=false
AUTO_UPDATE_LEGACY=false
PUBKEY_SRC=""
UPDATE_ENABLED=1
UPDATE_SCHEDULE=$DEFAULT_SCHEDULE
UPDATE_REPO=$DEFAULT_UPDATE_REPO
PINNED_VERSION=""
decide_auto_update() {
  local unit_file script existing_new=false key_text
  unit_file=$(fs "${SYSTEMD_DIR}/${UPDATER_UNIT}.timer")
  script=$(fs "$UPDATER_SCRIPT")
  if [[ -f $unit_file || -f $(fs "${SYSTEMD_DIR}/${UPDATER_UNIT}.service") ]]; then
    if [[ -f $script ]] && grep -q 'tv-updater-common' -- "$script" && [[ -f $(fs "$UPDATE_CONF") ]]; then
      existing_new=true
    else
      AUTO_UPDATE_LEGACY=true
    fi
  fi
  case "$OPT_AUTO_UPDATE" in
    enable) AUTO_UPDATE=true ;;
    disable) AUTO_UPDATE=false ;;
    *) if $UPGRADE && $existing_new; then AUTO_UPDATE=true; fi ;;
  esac
  # Checked before anything is changed: these files are (re)written below.
  if [[ $AUTO_UPDATE == true || $OPT_AUTO_UPDATE == disable ]]; then
    [[ ! -L $(fs "$UPDATE_CONF") && ! -L $(fs "$PUBKEY_DEST") ]] \
      || die "${UPDATE_CONF} or ${PUBKEY_DEST} is a symlink — refusing"
  fi
  if [[ $AUTO_UPDATE == true ]]; then
    # The installed trust anchor (shared with the server updater) is only ever replaced by
    # an explicit --release-pubkey, never by a key shipped inside a package.
    if [[ -n $OPT_PUBKEY ]]; then
      PUBKEY_SRC=$OPT_PUBKEY
    elif [[ -f $(fs "$PUBKEY_DEST") ]]; then
      PUBKEY_SRC=$(fs "$PUBKEY_DEST")
    elif [[ -f "${SCRIPT_DIR}/release-signing.pub" ]]; then
      PUBKEY_SRC="${SCRIPT_DIR}/release-signing.pub"
    else
      die "--auto-update needs the release public key: --release-pubkey FILE (or release-signing.pub next to install-client.sh)"
    fi
    command -v openssl >/dev/null 2>&1 || die "--auto-update needs openssl"
    key_text=$(openssl pkey -pubin -in "$PUBKEY_SRC" -noout -text 2>/dev/null) || key_text=""
    [[ $key_text == *prime256v1* || $key_text == *P-256* ]] \
      || die "release public key $(printf '%q' "$PUBKEY_SRC") is not an ECDSA P-256 PEM public key"
    [[ -f "${SCRIPT_DIR}/auto-update-client.sh" ]] || die "auto-update-client.sh missing next to install-client.sh"
  fi
}

remove_updater_units() {
  local u removed=false
  if [[ -f $(fs "${SYSTEMD_DIR}/${UPDATER_UNIT}.timer") ]]; then
    systemctl disable --now "${UPDATER_UNIT}.timer" >/dev/null 2>&1 || true
  fi
  for u in "${UPDATER_UNIT}.timer" "${UPDATER_UNIT}.service"; do
    if [[ -f $(fs "${SYSTEMD_DIR}/${u}") ]]; then
      rm -f -- "$(fs "${SYSTEMD_DIR}/${u}")"
      removed=true
    fi
  done
  rm -f -- "$(fs "$UPDATER_SCRIPT")"
  if $removed; then systemctl daemon-reload; fi
  $removed
}

# The server's signed updater (not its old git-pull one) reads the same update.conf.
server_updater_installed() {
  local script
  script=$(fs "$SERVER_UPDATER_SCRIPT")
  [[ -f $(fs "${SYSTEMD_DIR}/${SERVER_UPDATER_UNIT}.timer") && -f $script ]] && grep -q 'tv-updater-common' -- "$script"
}

# Existing update.conf values (validated, defaults otherwise) -> UPDATE_* variables.
read_update_conf() {
  local conf=$1 enabled
  enabled=$(conf_value "$conf" ENABLED)
  UPDATE_ENABLED=1
  case "${enabled,,}" in
    0|false|no|off) UPDATE_ENABLED=0 ;;
  esac
  UPDATE_REPO=$(conf_value "$conf" UPDATE_REPO)
  PINNED_VERSION=$(conf_value "$conf" PINNED_VERSION)
  UPDATE_SCHEDULE=$(conf_value "$conf" SCHEDULE)
  [[ $UPDATE_REPO =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ && $UPDATE_REPO != *..* ]] || UPDATE_REPO=$DEFAULT_UPDATE_REPO
  [[ -z $PINNED_VERSION || $PINNED_VERSION =~ ^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || PINNED_VERSION=""
  valid_schedule "$UPDATE_SCHEDULE" || UPDATE_SCHEDULE=$DEFAULT_SCHEDULE
}

configure_auto_update() {
  local conf
  conf=$(fs "$UPDATE_CONF")
  if [[ $AUTO_UPDATE != true ]]; then
    if remove_updater_units; then
      if $AUTO_UPDATE_LEGACY; then
        warn "Removed the old git-based auto-updater (it pulled unsigned code as root)"
      else
        info "Auto-updater removed"
      fi
    fi
    # update.conf is shared: ENABLED=0 would also pause the server's updater on this host.
    if [[ $OPT_AUTO_UPDATE == disable && -f $conf ]]; then
      if server_updater_installed; then
        info "${UPDATE_CONF} is shared with the server auto-updater on this host — ENABLED left unchanged there"
      else
        read_update_conf "$conf"
        UPDATE_ENABLED=0
        render_update_conf | write_root_file "$conf" 0644
      fi
    fi
    skipped "Signed auto-updates are off — enable with: sudo bash install-client.sh --upgrade --auto-update --release-pubkey release-signing.pub"
    return 0
  fi

  read_update_conf "$conf"
  # --auto-update (re-)enables; a plain --upgrade keeps a pause (ENABLED=0)
  [[ $OPT_AUTO_UPDATE != enable ]] || UPDATE_ENABLED=1

  if [[ $PUBKEY_SRC != "$(fs "$PUBKEY_DEST")" ]]; then
    write_root_file "$(fs "$PUBKEY_DEST")" 0644 < "$PUBKEY_SRC"
  fi
  if [[ -f "${SCRIPT_DIR}/release-signing.pub" ]] && ! cmp -s "${SCRIPT_DIR}/release-signing.pub" "$(fs "$PUBKEY_DEST")"; then
    warn "release-signing.pub of this package differs from ${PUBKEY_DEST} (kept; replace it with --release-pubkey FILE)"
  fi
  render_update_conf | write_root_file "$conf" 0644
  if $AUTO_UPDATE_LEGACY; then
    warn "Replacing the old git-based auto-updater with the signed-release updater"
  fi
  render_updater_service | write_root_file "$(fs "${SYSTEMD_DIR}/${UPDATER_UNIT}.service")" 0644
  render_updater_timer | write_root_file "$(fs "${SYSTEMD_DIR}/${UPDATER_UNIT}.timer")" 0644
  systemctl daemon-reload
  systemctl enable --now "${UPDATER_UNIT}.timer" >/dev/null 2>&1 || systemctl enable --now "${UPDATER_UNIT}.timer"
  if [[ $UPDATE_ENABLED == 1 ]]; then
    info "Signed auto-updater enabled (every ${UPDATE_SCHEDULE}; key ${PUBKEY_DEST}; settings ${UPDATE_CONF})"
  else
    warn "Auto-updater installed but ENABLED=0 in ${UPDATE_CONF} (kept) — updates are paused"
  fi
  info "Logs: journalctl -u ${UPDATER_UNIT} and ${UPDATER_LOG}"
  if server_updater_installed; then
    info "${UPDATE_CONF} is shared with the server auto-updater on this host: ENABLED=0 pauses both,"
    info "UPDATE_REPO, PINNED_VERSION and SCHEDULE apply to both (each keeps its own timer)."
  fi
}

# systemd-run survives the end of the calling unit/session (a background `sleep`
# inside the updater's oneshot service would be killed with it).
schedule_restart() {
  local systemctl_bin unit
  systemctl_bin=$(command -v systemctl)
  unit="tunnelvault-client-restart-$(date +%s)-$$"
  if command -v systemd-run >/dev/null 2>&1; then
    if systemd-run --quiet --collect --unit="$unit" --on-active="${RESTART_DELAY}s" \
        "$systemctl_bin" restart "${SERVICE_NAME}.service" >/dev/null 2>&1 \
      || systemd-run --quiet --unit="$unit" --on-active="${RESTART_DELAY}s" \
        "$systemctl_bin" restart "${SERVICE_NAME}.service" >/dev/null 2>&1; then
      return 0
    fi
  fi
  # (fd 8/9: installer/updater locks — not inherited by the delayed restart)
  nohup setsid bash -c "sleep ${RESTART_DELAY}; '${systemctl_bin}' restart '${SERVICE_NAME}.service'" \
    > /dev/null 2>&1 < /dev/null 8>&- 9>&- &
  disown || true
}

apply_restart() {
  local status
  if [[ $TUNNEL_ACTIVE == true ]]; then
    schedule_restart
    echo ""
    echo -e "  ${BOLD}${YELLOW}⚠  The tunnel restarts in ~${RESTART_DELAY} seconds to load the new version${NC}"
    echo -e "  ${DIM}An SSH session running through this tunnel will disconnect; reconnect afterwards.${NC}"
  else
    systemctl restart "$SERVICE_NAME" 2>/dev/null || systemctl start "$SERVICE_NAME"
    [[ -n $TV_ROOT ]] || sleep 3
    status=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)
    if [[ $status == active ]]; then
      info "Service is running"
    else
      warn "Service status: ${status:-unknown} — check: journalctl -u ${SERVICE_NAME} -f"
    fi
  fi
}

print_summary() {
  local tunnels_desc
  if $TUNNELS_FROM_ARGS; then
    tunnels_desc=$(printf '%s\n' "$TUNNEL_SPECS" | awk 'NF==3 { printf "%s%s/%s (%s)", (n++ ? ", " : ""), $1, $2, $3 }')
  else
    tunnels_desc=$(TV_TUNNELS_JSON="$TUNNELS_JSON" node -e "$NODE_DESCRIBE_TUNNELS" 2>/dev/null || echo "?")
  fi
  echo ""
  if $UPGRADE; then
    echo -e "${BOLD}${GREEN}  TunnelVault Client Upgrade Complete!${NC}"
  else
    echo -e "${BOLD}${GREEN}  TunnelVault Client Installation Complete!${NC}"
  fi
  echo ""
  echo -e "  ${DIM}Version:${NC}        $(tree_version)"
  echo -e "  ${DIM}Server:${NC}         ${SERVER_URL}"
  echo -e "  ${DIM}Service user:${NC}   ${SERVICE_USER}"
  echo -e "  ${DIM}Tunnels:${NC}        ${tunnels_desc}"
  if [[ $ALLOW_REBOOT == true ]]; then
    echo -e "  ${DIM}Remote reboot:${NC}  enabled (disable: sudo bash install-client.sh --upgrade --no-reboot)"
  else
    echo -e "  ${DIM}Remote reboot:${NC}  disabled (enable: sudo bash install-client.sh --upgrade --allow-reboot)"
  fi
  echo -e "  ${DIM}Config:${NC}         ${SYS_CONFIG} (token and reboot switch: ${CLIENT_ENV})"
  echo -e "  ${DIM}State:${NC}          ${STATE_DIR} (keeps the public ports across restarts and upgrades)"
  if [[ $AUTO_UPDATE == true && $UPDATE_ENABLED == 1 ]]; then
    echo -e "  ${DIM}Auto-update:${NC}    signed releases, every ${UPDATE_SCHEDULE} (${UPDATE_CONF})"
  elif [[ $AUTO_UPDATE == true ]]; then
    echo -e "  ${DIM}Auto-update:${NC}    installed but paused (ENABLED=0 in ${UPDATE_CONF})"
  else
    echo -e "  ${DIM}Auto-update:${NC}    off"
  fi
  echo ""
  echo -e "  ${BOLD}Useful Commands${NC}"
  echo -e "  ────────────────────────────────────────────────────"
  echo -e "  ${DIM}View logs:${NC}      journalctl -u ${SERVICE_NAME} -f"
  echo -e "  ${DIM}Restart:${NC}        sudo systemctl restart ${SERVICE_NAME}"
  echo -e "  ${DIM}Stop:${NC}           sudo systemctl stop ${SERVICE_NAME}"
  echo -e "  ${DIM}Change token:${NC}   sudo bash install-client.sh --upgrade --token NEW_TOKEN"
  echo -e "  ${DIM}Upgrade:${NC}        download a release (tunnelvault-vX.Y.Z.tar.gz + SHA256SUMS + SHA256SUMS.sig), verify it"
  echo -e "                  with the release key you trust (not one shipped inside the download):"
  echo -e "                    openssl dgst -sha256 -verify release-signing.pub -signature SHA256SUMS.sig SHA256SUMS"
  echo -e "                    sha256sum -c --ignore-missing SHA256SUMS"
  echo -e "                  then run from the extracted directory: sudo bash install-client.sh --upgrade"
  if [[ $AUTO_UPDATE == true ]]; then
    echo -e "  ${DIM}Update logs:${NC}    journalctl -u ${UPDATER_UNIT} and ${UPDATER_LOG}"
    echo -e "  ${DIM}Update now:${NC}     sudo ${UPDATER_SCRIPT} [--dry-run]"
  fi
  echo ""
  if is_insecure_remote_url "$SERVER_URL"; then
    echo -e "  ${BOLD}${RED}WARNING:${NC} ${BOLD}${SERVER_URL} is plaintext (ws://) to a public host.${NC}"
    echo -e "  ${YELLOW}The device token and all tunnelled traffic cross the internet unencrypted.${NC}"
    echo -e "  ${YELLOW}Install the server with --tls and re-run: sudo bash install-client.sh --upgrade --server wss://YOUR-DOMAIN${NC}"
    echo ""
  fi
  echo -e "  ${DIM}Once connected, the device and its public ports appear in the dashboard.${NC}"
  echo ""
}

main() {
  parse_args "$@"
  validate_args
  [[ $EUID -eq 0 ]] || die "Run as root: sudo bash install-client.sh ..."

  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "${SCRIPT_DIR}/client/package.json" ]] \
    || die "client/ directory not found. Run this script from the extracted TunnelVault release (or repository root)."
  command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
  for tool in tar cmp install flock mktemp getent id; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"
  done
  umask 022
  trap cleanup EXIT

  ensure_dir "$(dirname -- "$(fs "$LOCK_FILE")")"
  exec 8>"$(fs "$LOCK_FILE")"
  flock -w 900 8 || die "another install-client.sh run is still in progress"

  echo ""
  echo -e "${BOLD}${CYAN}  TunnelVault Client Installer${NC}"
  if $UPGRADE; then
    echo -e "  ${DIM}Mode: UPGRADE (keeping configuration unless overridden)${NC}"
  else
    echo -e "  ${DIM}Mode: Fresh install${NC}"
  fi
  [[ -z $TV_ROOT ]] || echo -e "  ${YELLOW}TEST MODE: files are written below ${TV_ROOT}${NC}"

  step "Checking Node.js (>= 20)"
  ensure_node

  step "Reading configuration"
  resolve_settings
  decide_auto_update

  TUNNEL_ACTIVE=false
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    TUNNEL_ACTIVE=true
    warn "Tunnel service is running — files are swapped live, the restart is delayed by ${RESTART_DELAY}s"
  fi

  step "Installing client files"
  install_client_files

  step "Writing configuration"
  write_configs
  configure_reboot

  step "Configuring services"
  write_service_unit
  configure_auto_update

  step "Applying"
  apply_restart
  print_summary
}

if [[ ${TV_INSTALL_CLIENT_SOURCE_ONLY:-} != 1 ]]; then
  main "$@"
fi
