#!/bin/bash
# ============================================================
# register_token.sh — manage legacy SSH-gateway tokens from the shell.
#
# The dashboard / REST API (/api/tokens) is the preferred way to manage
# tokens: it also disconnects live device connections immediately. This
# script edits the same database (schema owned by the backend) as the
# service user and manages the gateway Linux user via manage-user.sh.
#
# Usage: sudo /opt/tunnelvault/register_token.sh [OPTIONS]   (see --help)
# ============================================================
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

readonly INSTALL_DIR="/opt/tunnelvault"
readonly SERVICE_USER="tunnelvault"
readonly ENV_FILE="${INSTALL_DIR}/backend/.env"
readonly DEFAULT_DB_PATH="${INSTALL_DIR}/data/tunnelvault.db"
readonly MANAGE_USER="${INSTALL_DIR}/manage-user.sh"
readonly MAX_GATEWAY_TOKEN_LENGTH=29      # 'gw-' + token <= 32 (Linux username limit)
readonly PUBKEY_RE='^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+|ssh-dss|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [[:print:]]*)?$'
readonly OCTET='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'

usage() {
    cat <<EOF
Usage: sudo $0 [OPTIONS]

Create or update a gateway token (creates the Linux user gw-<TOKEN>):
  --token    TOKEN    1-${MAX_GATEWAY_TOKEN_LENGTH} letters/digits (required)
  --ip       IP       Target IPv4 address (required, e.g. 10.0.1.10)
  --port     PORT     Target SSH port (default: 22)
  --label    TEXT     Description, max 200 bytes, no control characters
  --pubkey   KEY      SSH public key of the client (required)

  --disable  TOKEN    Disable a token (new connections are refused, live
                      gateway sessions are terminated)
  --enable   TOKEN    Re-enable a disabled token
  --delete   TOKEN    Delete a token, its sessions and its Linux user
  --list              Show all tokens

Example:
  $0 --token xK9mQp --ip 10.0.1.42 --label "Acme Corp Dev" \\
     --pubkey "ssh-ed25519 AAAAC3Nza... user@laptop"
EOF
    exit "${1:-1}"
}

die() { echo "Error: $*" >&2; exit 1; }

[[ $# -eq 0 ]] && usage 1

TOKEN=""; TARGET_IP=""; TARGET_PORT="22"; LABEL=""; LABEL_SET=false; PUBKEY=""
DISABLE=""; ENABLE=""; DELETE=""; LIST=false

need_arg() { [[ $# -ge 2 ]] || die "$1 requires a value"; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --token)   need_arg "$@"; TOKEN="$2";       shift 2 ;;
        --ip)      need_arg "$@"; TARGET_IP="$2";   shift 2 ;;
        --port)    need_arg "$@"; TARGET_PORT="$2"; shift 2 ;;
        --label)   need_arg "$@"; LABEL="$2"; LABEL_SET=true; shift 2 ;;
        --pubkey)  need_arg "$@"; PUBKEY="$2";      shift 2 ;;
        --disable) need_arg "$@"; DISABLE="$2";     shift 2 ;;
        --enable)  need_arg "$@"; ENABLE="$2";      shift 2 ;;
        --delete)  need_arg "$@"; DELETE="$2";      shift 2 ;;
        --list)    LIST=true;                       shift ;;
        -h|--help) usage 0 ;;
        *)         echo "Unknown option: $1" >&2; usage 1 ;;
    esac
done

[[ $EUID -eq 0 ]] || die "Please run as root (sudo)."

# ── Helpers ──────────────────────────────────────────────────
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

# SQL text literal that cannot break out of its quotes: hex blob cast to TEXT
sql_text() {
    local hex
    hex="$(printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n')"
    printf "CAST(X'%s' AS TEXT)" "$hex"
}

# Run SQL as the service user (keeps the database and its WAL files owned by it)
run_sql() {
    runuser -u "$SERVICE_USER" -- sqlite3 -init /dev/null -batch -bail -noheader -list \
        -separator "$SEP" -cmd '.timeout 5000' "$DB_PATH" "$1" </dev/null
}
SEP=$'\x1f'

valid_pubkey() {
    local pk="$1"
    (( ${#pk} > 0 && ${#pk} <= 8192 )) || return 1
    case "$pk" in
        *'`'* | *'$'* | *\\* | *'"'* | *"'"*) return 1 ;;
    esac
    [[ "$pk" =~ $PUBKEY_RE ]]
}

check_existing_token() {
    [[ "$1" =~ ^[A-Za-z0-9]{1,64}$ ]] || die "Invalid token format (1-64 letters/digits)."
}

terminate_gateway_sessions() {
    local user="$1"
    if [[ "$user" =~ ^gw-[A-Za-z0-9]{1,29}$ ]] && getent passwd "$user" >/dev/null 2>&1; then
        if pkill -TERM -u "$user" >/dev/null 2>&1; then echo "Live gateway sessions terminated."; fi
    fi
}

REVOKE_NOTE="Note: live device (WebSocket) connections using this token are closed by the
server within ~30 seconds. Use the dashboard or the API for immediate revocation."

# ── Environment checks ───────────────────────────────────────
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed (apt-get install sqlite3)."
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "Service user '${SERVICE_USER}' not found — is TunnelVault installed?"
DB_PATH="$(db_path_from_env)"
DB_PATH="${DB_PATH:-$DEFAULT_DB_PATH}"
[[ "$DB_PATH" =~ ^/[A-Za-z0-9._/-]+$ && "$DB_PATH" != *..* ]] || die "Unsupported DB_PATH in ${ENV_FILE}."
[[ -f "$DB_PATH" ]] || die "Database ${DB_PATH} not found — start the service first: systemctl start tunnelvault"
HAS_TABLE="$(run_sql "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'tokens';")" \
    || die "Cannot read ${DB_PATH}."
[[ "$HAS_TABLE" == "1" ]] || die "Database schema missing — start the service once (systemctl start tunnelvault); it creates the schema."

# ── List ─────────────────────────────────────────────────────
if $LIST; then
    printf '%-30s %-20s %-15s %-5s %-6s %s\n' TOKEN LABEL IP PORT ACTIVE "LAST SEEN"
    printf '%s\n' "------------------------------------------------------------------------------------------"
    run_sql "SELECT token,
                    replace(replace(replace(substr(label, 1, 20), char(10), ' '), char(13), ' '), char(9), ' '),
                    target_ip, target_port, active, COALESCE(last_seen, 'never')
             FROM tokens ORDER BY created_at DESC;" \
    | awk -F "$SEP" '{
        # terminal-safe: no C0/C1 control characters from labels written through the API
        for (i = 1; i <= NF; i++) { gsub(/[[:cntrl:]]/, "?", $i); gsub(/\302[\200-\237]/, "?", $i) }
        printf "%-30s %-20s %-15s %-5s %-6s %s\n", $1, $2, $3, $4, ($5 == "1" ? "yes" : "NO"), $6
      }'
    exit 0
fi

# ── Disable / enable ─────────────────────────────────────────
if [[ -n "$DISABLE" || -n "$ENABLE" ]]; then
    T="${DISABLE:-$ENABLE}"
    check_existing_token "$T"
    if [[ -n "$DISABLE" ]]; then VALUE=0; else VALUE=1; fi
    CHANGED="$(run_sql "UPDATE tokens SET active = ${VALUE} WHERE token = '${T}'; SELECT changes();")" \
        || die "Database update failed."
    [[ "$CHANGED" == "1" ]] || die "Token not found."
    if [[ -n "$DISABLE" ]]; then
        terminate_gateway_sessions "gw-${T}"
        echo "Token '${T}' disabled. New connections will be refused."
        echo "$REVOKE_NOTE"
    else
        echo "Token '${T}' enabled."
    fi
    exit 0
fi

# ── Delete ───────────────────────────────────────────────────
if [[ -n "$DELETE" ]]; then
    check_existing_token "$DELETE"
    LINUX_USER="$(run_sql "SELECT linux_user FROM tokens WHERE token = '${DELETE}';")" \
        || die "Database query failed."
    [[ -n "$LINUX_USER" ]] || die "Token not found."
    PIN_PREFIX="token:${DELETE}:"
    run_sql "BEGIN IMMEDIATE;
             DELETE FROM ssh_host_keys WHERE substr(pin_key, 1, ${#PIN_PREFIX}) = '${PIN_PREFIX}';
             DELETE FROM sessions WHERE token = '${DELETE}';
             DELETE FROM tokens WHERE token = '${DELETE}';
             COMMIT;" >/dev/null || die "Database update failed."
    if [[ "$LINUX_USER" =~ ^gw-[A-Za-z0-9]{1,29}$ ]]; then
        "$MANAGE_USER" delete "$LINUX_USER" || echo "Warning: could not remove the Linux user." >&2
    fi
    echo "Token '${DELETE}' deleted."
    echo "$REVOKE_NOTE"
    exit 0
fi

# ── Create / update ──────────────────────────────────────────
[[ -n "$TOKEN" ]]     || { echo "Error: --token is required" >&2; usage 1; }
[[ -n "$TARGET_IP" ]] || { echo "Error: --ip is required" >&2; usage 1; }
[[ -n "$PUBKEY" ]]    || { echo "Error: --pubkey is required (SSH public key)" >&2; usage 1; }

[[ "$TOKEN" =~ ^[A-Za-z0-9]+$ ]] || die "Token must contain only letters and digits."
(( ${#TOKEN} <= MAX_GATEWAY_TOKEN_LENGTH )) \
    || die "Gateway tokens are limited to ${MAX_GATEWAY_TOKEN_LENGTH} characters (Linux user gw-<token> max 32)."
[[ "$TARGET_IP" =~ ^${OCTET}\.${OCTET}\.${OCTET}\.${OCTET}$ ]] || die "Invalid IPv4 address: '${TARGET_IP}'"
if [[ ! "$TARGET_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( TARGET_PORT > 65535 )); then
    die "Invalid port: '${TARGET_PORT}'"
fi
(( ${#LABEL} <= 200 )) || die "Label is limited to 200 characters."
[[ "$LABEL" != *[[:cntrl:]]* ]] || die "Label must not contain control characters."
# trim surrounding whitespace like the API does
PUBKEY="${PUBKEY#"${PUBKEY%%[![:space:]]*}"}"
PUBKEY="${PUBKEY%"${PUBKEY##*[![:space:]]}"}"
valid_pubkey "$PUBKEY" \
    || die "Invalid SSH public key (single line 'TYPE BASE64 [comment]': ssh-ed25519, ssh-rsa, ecdsa-sha2-*, sk-*)."

LINUX_USER="gw-${TOKEN}"
if $LABEL_SET; then LABEL_UPDATE="excluded.label"; else LABEL_UPDATE="tokens.label"; fi

run_sql "INSERT INTO tokens (token, label, target_ip, target_port, public_key, linux_user)
         VALUES ('${TOKEN}', $(sql_text "$LABEL"), '${TARGET_IP}', ${TARGET_PORT}, $(sql_text "$PUBKEY"), '${LINUX_USER}')
         ON CONFLICT(token) DO UPDATE SET
             label       = ${LABEL_UPDATE},
             target_ip   = excluded.target_ip,
             target_port = excluded.target_port,
             public_key  = excluded.public_key,
             linux_user  = excluded.linux_user,
             active      = 1;" >/dev/null \
    || die "Database update failed (is the Linux user name already used by another token?)."

"$MANAGE_USER" create "$LINUX_USER" "$PUBKEY" || die "Token saved, but the Linux user could not be set up (see above)."

GATEWAY_HOST="$(hostname -f 2>/dev/null || hostname)"

echo ""
echo "Token registered successfully"
echo "---------------------------------------------------------"
echo "  Token:      ${TOKEN}"
echo "  Linux user: ${LINUX_USER}"
echo "  Target:     ${TARGET_IP}:${TARGET_PORT}"
$LABEL_SET && echo "  Label:      ${LABEL}"
echo ""
echo "  Client ~/.ssh/config entry:"
echo ""
echo "  Host <alias>"
echo "      HostName ${GATEWAY_HOST}"
echo "      User ${LINUX_USER}"
echo "      IdentityFile ~/.ssh/<private key matching the public key>"
echo ""
echo "  Connect: ssh <alias>"
echo "---------------------------------------------------------"
