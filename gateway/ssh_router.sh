#!/bin/bash
# ============================================================
# ssh_router.sh — ForceCommand (and login shell) of the legacy SSH
# gateway users "gw-<token>".
#
# Looks up the token's target through gateway-helper.sh (run as the
# service user via sudo — gateway users cannot read the configuration or
# the database themselves), records the session, and relays the SSH
# stream to target_ip:target_port with netcat. The SSH client handshakes
# end-to-end with the target.
#
# Arguments (sshd passes "-c <command>" because this is the login shell)
# and SSH_ORIGINAL_COMMAND are ignored on purpose.
# Logs go to syslog: journalctl -t tunnelvault-gateway
# Must be owned by root, mode 0755.
# ============================================================
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

readonly INSTALL_DIR="/opt/tunnelvault"
readonly SERVICE_USER="tunnelvault"
readonly HELPER="${INSTALL_DIR}/gateway-helper.sh"
readonly HELPER_TIMEOUT=15

USER_HINT="?"
SESSION_ID=""
NC_PID=""
TARGET=""

log() { logger -t tunnelvault-gateway -p auth.info -- "[$$] user=${USER_HINT} $*" 2>/dev/null || true; }

die() {
    log "DENIED: $1"
    echo "TunnelVault gateway: ${2:-access denied}" >&2
    exit 1
}

# Never let a helper read the SSH stream: stdin is /dev/null.
helper() {
    timeout "$HELPER_TIMEOUT" sudo -n -u "$SERVICE_USER" -- "$HELPER" "$@" </dev/null 2>/dev/null
}

# ── Identity (from the kernel, not from the environment) ───────
LINUX_USER="$(id -un 2>/dev/null || true)"
if [[ ! "$LINUX_USER" =~ ^gw-[A-Za-z0-9]{1,29}$ ]]; then
    USER_HINT="invalid"
    die "not a gateway user" "invalid gateway user"
fi
USER_HINT="${LINUX_USER:0:7}***"

CLIENT_IP="${SSH_CLIENT:-}"
CLIENT_IP="${CLIENT_IP%% *}"
[[ "$CLIENT_IP" =~ ^[0-9A-Fa-f.:]{2,45}$ ]] || CLIENT_IP="-"

# ── Route lookup ───────────────────────────────────────────────
ROW="$(helper lookup)"
rc=$?
case "$rc" in
    0) ;;
    3) die "unknown token (client=${CLIENT_IP})" "unknown or disabled token" ;;
    *) die "lookup failed (rc=${rc}, client=${CLIENT_IP})" "gateway temporarily unavailable" ;;
esac

IFS='|' read -r TARGET_IP TARGET_PORT ACTIVE _ <<< "$ROW"
[[ "${ACTIVE:-}" == "1" ]] || die "token disabled (client=${CLIENT_IP})" "unknown or disabled token"

octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
if [[ ! "${TARGET_IP:-}" =~ ^${octet}\.${octet}\.${octet}\.${octet}$ ]]; then
    die "no valid target IP configured" "no target configured for this token"
fi
if [[ ! "${TARGET_PORT:-}" =~ ^[1-9][0-9]{0,4}$ ]] || (( TARGET_PORT > 65535 )); then
    die "invalid target port configured" "no target configured for this token"
fi
TARGET="${TARGET_IP}:${TARGET_PORT}"

# ── Session record + cleanup ───────────────────────────────────
# shellcheck disable=SC2317,SC2329 # invoked through the EXIT trap (SC2317: shellcheck < 0.10)
cleanup() {
    trap - EXIT HUP INT TERM
    if [[ -n "$NC_PID" ]]; then
        kill "$NC_PID" 2>/dev/null || true
    fi
    if [[ -n "$SESSION_ID" ]]; then
        helper session-end "$SESSION_ID" >/dev/null || log "WARN: could not close session ${SESSION_ID}"
    fi
    log "SESSION_END id=${SESSION_ID:-none} target=${TARGET}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SESSION_ID="$(helper session-start "$CLIENT_IP" "$$")" || SESSION_ID=""
if [[ ! "$SESSION_ID" =~ ^[0-9]+$ ]]; then
    log "WARN: session could not be recorded"
    SESSION_ID=""
fi
log "SESSION_START id=${SESSION_ID:-none} client=${CLIENT_IP} target=${TARGET}"

# ── Relay ──────────────────────────────────────────────────────
# Runs in the background (with the SSH stream as explicit stdin) so that a
# hangup/termination signal is handled immediately and the session is closed.
nc -q0 "$TARGET_IP" "$TARGET_PORT" <&0 &
NC_PID=$!
wait "$NC_PID"
rc=$?
NC_PID=""
exit "$rc"
