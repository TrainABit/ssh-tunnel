#!/bin/bash
# ============================================================
# gateway-helper.sh — database access for the legacy SSH gateway.
#
# Runs as the TunnelVault service user. Gateway users (gw-<token>, group
# tunnelvault-gw) may run it through sudo (see /etc/sudoers.d/tunnelvault):
#
#   sudo -n -u tunnelvault /opt/tunnelvault/gateway-helper.sh lookup
#       -> prints "target_ip|target_port|active" of the caller's token
#   sudo -n -u tunnelvault /opt/tunnelvault/gateway-helper.sh session-start <client_ip> <pid>
#       -> records a session for the caller's (active) token, prints its id
#   sudo -n -u tunnelvault /opt/tunnelvault/gateway-helper.sh session-end <session_id>
#       -> closes one of the caller's own open sessions
#
# The token is derived from SUDO_USER (set by sudo, not by the caller), so a
# gateway user can only ever read or write rows of its own token. Every
# argument is validated against a strict pattern before it is placed in SQL.
#
# Exit codes: 0 ok, 1 error, 2 usage, 3 not found / not allowed.
# Must be owned by root, mode 0755.
# ============================================================
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

readonly INSTALL_DIR="/opt/tunnelvault"
readonly SERVICE_USER="tunnelvault"
readonly ENV_FILE="${INSTALL_DIR}/backend/.env"
readonly DEFAULT_DB_PATH="${INSTALL_DIR}/data/tunnelvault.db"

die()   { echo "gateway-helper: $*" >&2; exit 1; }
deny()  { echo "gateway-helper: $*" >&2; exit 3; }
usage() { echo "usage: gateway-helper.sh lookup | session-start <client_ip> <pid> | session-end <session_id>" >&2; exit 2; }

[[ "$(id -un)" == "$SERVICE_USER" ]] || die "must run as ${SERVICE_USER} (use: sudo -n -u ${SERVICE_USER} $0 ...)"

# ── Caller identity ──────────────────────────────────────────
CALLER="${SUDO_USER:-}"
[[ "$CALLER" =~ ^gw-([A-Za-z0-9]{1,29})$ ]] || deny "caller is not a gateway user"
TOKEN="${BASH_REMATCH[1]}"

# ── Database location (DB_PATH from the service configuration) ─
db_path_from_env() {
    local line value
    [[ -r "$ENV_FILE" ]] || return 0
    line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?DB_PATH[[:space:]]*=' "$ENV_FILE" | tail -n 1 || true)"
    value="${line#*=}"
    value="${value%%[[:space:]]#*}"     # inline comment (dotenv style)
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
    fi
    printf '%s' "$value"
}

DB_PATH="$(db_path_from_env)"
DB_PATH="${DB_PATH:-$DEFAULT_DB_PATH}"
[[ "$DB_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$DB_PATH" != *..* ]] || die "unsupported DB_PATH"
[[ -f "$DB_PATH" ]] || die "database not found"
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed"

# -init /dev/null: never read ~/.sqliterc; stdin is not the SSH stream.
sql() {
    sqlite3 -init /dev/null -batch -bail -noheader -list -separator '|' \
        -cmd '.timeout 5000' "$DB_PATH" "$1" </dev/null
}

ACTION="${1:-}"
case "$ACTION" in
    lookup)
        [[ $# -eq 1 ]] || usage
        ROW="$(sql "SELECT target_ip, target_port, active FROM tokens
                    WHERE token = '${TOKEN}' AND linux_user = 'gw-${TOKEN}' LIMIT 1;")" \
            || die "database query failed"
        [[ -n "$ROW" ]] || deny "unknown token"
        printf '%s\n' "$ROW"
        ;;

    session-start)
        [[ $# -eq 3 ]] || usage
        CLIENT_IP="$2"
        PID="$3"
        if [[ "$CLIENT_IP" =~ ^[0-9A-Fa-f.:]{2,45}$ ]]; then
            IP_SQL="'${CLIENT_IP}'"
        else
            IP_SQL="NULL"
        fi
        if [[ ! "$PID" =~ ^[1-9][0-9]{0,6}$ ]] || (( PID > 4194304 )); then usage; fi
        ID="$(sql "BEGIN IMMEDIATE;
                   INSERT INTO sessions (token, client_ip, pid, target_ip, target_port)
                     SELECT token, ${IP_SQL}, ${PID}, target_ip, target_port FROM tokens
                     WHERE token = '${TOKEN}' AND linux_user = 'gw-${TOKEN}' AND active = 1;
                   SELECT CASE WHEN changes() = 1 THEN last_insert_rowid() ELSE '' END;
                   UPDATE tokens SET last_seen = datetime('now')
                     WHERE token = '${TOKEN}' AND linux_user = 'gw-${TOKEN}' AND active = 1;
                   COMMIT;")" || die "database update failed"
        [[ "$ID" =~ ^[0-9]+$ ]] || deny "token unknown or disabled"
        printf '%s\n' "$ID"
        ;;

    session-end)
        [[ $# -eq 2 ]] || usage
        SESSION_ID="$2"
        [[ "$SESSION_ID" =~ ^[1-9][0-9]{0,14}$ ]] || usage
        CHANGED="$(sql "UPDATE sessions SET disconnected_at = datetime('now')
                        WHERE id = ${SESSION_ID} AND token = '${TOKEN}' AND disconnected_at IS NULL;
                        SELECT changes();")" || die "database update failed"
        [[ "$CHANGED" == "1" ]] || deny "no such open session"
        ;;

    *)
        usage
        ;;
esac
