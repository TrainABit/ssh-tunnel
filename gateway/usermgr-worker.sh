#!/bin/bash
# ============================================================
# usermgr-worker.sh — applies Linux-user requests queued by the TunnelVault
# API for the legacy SSH gateway.
#
# The API runs as the unprivileged service user under systemd hardening
# (NoNewPrivileges, ProtectSystem) and cannot create users itself. With
# USERMGR_SPOOL_DIR set it writes request files "<ms>-<hex>.req" (JSON:
# {"action":"create"|"delete","username":"gw-…","publicKey":"…"}, mode 0600)
# into /opt/tunnelvault/data/usermgr. tunnelvault-usermgr.path notices them
# and starts tunnelvault-usermgr.service, which runs this script as root.
#
# The spool directory belongs to the (less trusted) service user, so:
#   - the spool path must not traverse symlinks and must be owned by the
#     service user and not writable by group/others; we then work relative
#     to that directory (cwd pinned to the verified inode)
#   - only regular, non-symlink, single-link files owned by the service user
#     and smaller than 16 KiB are accepted; they are opened with O_NOFOLLOW
#     and parsed as JSON by node (never sourced or eval'd)
#   - every field is validated again before manage-user.sh is called
#   - a request is removed before it is applied (at most once), invalid
#     requests are removed/set aside, so the path unit never loops
#   - the service's .env is never read (the service user could edit it)
#
# Environment overrides (root-only; used by the tests):
#   TUNNELVAULT_USERMGR_SPOOL, TUNNELVAULT_SERVICE_USER, TUNNELVAULT_MANAGE_USER
# Must be owned by root, mode 0755.
# ============================================================
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

SPOOL_DIR="${TUNNELVAULT_USERMGR_SPOOL:-/opt/tunnelvault/data/usermgr}"
SERVICE_USER="${TUNNELVAULT_SERVICE_USER:-tunnelvault}"
MANAGE_USER="${TUNNELVAULT_MANAGE_USER:-/opt/tunnelvault/manage-user.sh}"
readonly MAX_REQUEST_BYTES=16383
readonly NAME_RE='^[0-9]{1,20}-[A-Za-z0-9]{1,64}\.req$'
readonly USERNAME_RE='^gw-[A-Za-z0-9]{1,29}$'

log()  { echo "usermgr: $*"; }
fail() { echo "usermgr: ERROR: $*" >&2; exit 1; }

hint() {
    local s="$1"
    if (( ${#s} > 7 )); then printf '%s***' "${s:0:7}"; else printf '%s' "$s"; fi
}

# Printable, single-line, bounded version of an untrusted string for logs;
# gateway usernames embed the device token, so they are shortened to a hint.
sanitize() {
    local s="${1//[^[:print:]]/?}"
    s="$(printf '%s' "${s:0:200}" | sed -E 's/(gw-[A-Za-z0-9]{4})[A-Za-z0-9]+/\1***/g')"
    printf '%s' "$s"
}

# Parses and validates one request file (relative to the cwd). Prints
# "action\nusername\npublicKey\n" or exits non-zero with a reason on stderr.
# Same key rules as backend/src/userManager.js normalizePublicKey.
# shellcheck disable=SC2016 # JavaScript source, not shell expansions
readonly NODE_PARSER='
"use strict";
const fs = require("fs");
const [file, uidArg, maxArg] = process.argv.slice(1);
const max = Number(maxArg);
const bail = (why) => { process.stderr.write(why + "\n"); process.exit(1); };
const C = fs.constants;
let fd;
try {
  fd = fs.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | (C.O_NOCTTY || 0));
} catch (e) { bail("cannot open (" + (e.code || "error") + ")"); }
const st = fs.fstatSync(fd);
if (!st.isFile()) bail("not a regular file");
if (st.uid !== Number(uidArg)) bail("not owned by the service user");
if (st.nlink !== 1) bail("hard-linked file");
if (st.size > max) bail("too large");
const buf = Buffer.alloc(max + 1);
const n = fs.readSync(fd, buf, 0, max + 1, 0);
fs.closeSync(fd);
if (n > max) bail("too large");
let req;
try { req = JSON.parse(buf.subarray(0, n).toString("utf8")); } catch { bail("invalid JSON"); }
if (!req || typeof req !== "object" || Array.isArray(req)) bail("not a JSON object");
const action = req.action;
if (action !== "create" && action !== "delete") bail("invalid action");
const username = req.username;
if (typeof username !== "string" || !/^gw-[A-Za-z0-9]{1,29}$/.test(username)) bail("invalid username");
let key = "";
if (action === "create") {
  if (typeof req.publicKey !== "string") bail("missing publicKey");
  key = req.publicKey.trim();
  const KEY_RE = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-dss|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [\x20-\x7e]*)?$/;
  if (!key || key.length > 8192 || /[`$\\"\x27\r\n\0]/.test(key) || !KEY_RE.test(key)) bail("invalid publicKey");
}
process.stdout.write(action + "\n" + username + "\n" + key + "\n");
'

# Remove (or, for directories and other special files, rename aside) a
# request that must not be processed again.
discard() {
    local name="$1"
    if [[ -L "$name" || -f "$name" ]]; then
        rm -f -- "./${name}" 2>/dev/null && return 0
    fi
    mv -f -T -- "./${name}" "./.rejected-${name}-$$-${RANDOM}" 2>/dev/null \
        || log "WARN: could not remove $(sanitize "$name")"
}

# ── Preconditions ────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fail "must run as root"
command -v node >/dev/null 2>&1 || fail "node is not installed"
[[ -x "$MANAGE_USER" ]] || fail "${MANAGE_USER} is missing or not executable"
SERVICE_UID="$(id -u "$SERVICE_USER" 2>/dev/null)" || fail "service user '${SERVICE_USER}' does not exist"

# One worker at a time (the systemd unit never overlaps, manual runs might)
exec 9<"${BASH_SOURCE[0]}"
flock -w 300 9 || fail "another worker is still running"

# Parser diagnostics go to a private file so that warnings can never be mixed
# into the parsed fields.
ERR_FILE="$(mktemp)"
trap 'rm -f -- "$ERR_FILE"' EXIT

SPOOL_DIR="${SPOOL_DIR%/}"
[[ "$SPOOL_DIR" == /* ]] || fail "spool directory must be an absolute path"
if [[ ! -e "$SPOOL_DIR" && ! -L "$SPOOL_DIR" ]]; then
    log "spool directory ${SPOOL_DIR} does not exist — nothing to do"
    exit 0
fi
[[ -d "$SPOOL_DIR" && ! -L "$SPOOL_DIR" ]] || fail "${SPOOL_DIR} is not a directory"
cd -P -- "$SPOOL_DIR" || fail "cannot enter ${SPOOL_DIR}"
[[ "$(pwd -P)" == "$SPOOL_DIR" ]] || fail "${SPOOL_DIR} must not contain symlinks"
read -r DIR_UID DIR_MODE < <(stat -c '%u %a' .)
[[ "$DIR_UID" == "$SERVICE_UID" ]] || fail "${SPOOL_DIR} must be owned by ${SERVICE_USER}"
(( (8#$DIR_MODE & 8#022) == 0 )) || fail "${SPOOL_DIR} must not be writable by group or others"

# ── Process requests (oldest first) ──────────────────────────
shopt -s nullglob
requests=( *.req )
processed=0
rejected=0
for name in "${requests[@]}"; do
    [[ -e "$name" || -L "$name" ]] || continue   # vanished meanwhile
    safe_name="$(sanitize "$name")"

    if [[ ! "$name" =~ $NAME_RE ]]; then
        log "REJECTED ${safe_name}: unexpected file name"
        discard "$name"; rejected=$((rejected + 1)); continue
    fi
    if [[ -L "$name" || ! -f "$name" ]]; then
        log "REJECTED ${safe_name}: not a regular file"
        discard "$name"; rejected=$((rejected + 1)); continue
    fi

    if ! parsed="$(node -e "$NODE_PARSER" -- "./${name}" "$SERVICE_UID" "$MAX_REQUEST_BYTES" 2>"$ERR_FILE")"; then
        log "REJECTED ${safe_name}: $(sanitize "$(head -n 1 "$ERR_FILE")")"
        discard "$name"; rejected=$((rejected + 1)); continue
    fi

    # At most once: the request is gone before it is applied.
    rm -f -- "./${name}"

    mapfile -t fields <<< "$parsed"
    action="${fields[0]:-}"
    username="${fields[1]:-}"
    pubkey="${fields[2]:-}"
    if [[ ! "$username" =~ $USERNAME_RE ]] || [[ "$action" != "create" && "$action" != "delete" ]] \
        || [[ "$action" == "create" && -z "$pubkey" ]]; then
        log "REJECTED ${safe_name}: invalid request"
        rejected=$((rejected + 1)); continue
    fi

    user_hint="$(hint "$username")"
    if [[ "$action" == "create" ]]; then
        cmd=( "$MANAGE_USER" create "$username" "$pubkey" )
    else
        cmd=( "$MANAGE_USER" delete "$username" )
    fi
    if out="$(timeout 120 "${cmd[@]}" </dev/null 2>&1)"; then
        log "OK ${action} ${user_hint}"
    else
        log "FAILED ${action} ${user_hint}: $(sanitize "${out##*$'\n'}")"
    fi
    processed=$((processed + 1))
done

log "done: ${processed} applied, ${rejected} rejected"
exit 0
