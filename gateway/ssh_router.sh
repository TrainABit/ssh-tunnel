#!/bin/bash
# ============================================================
# ssh_router.sh – ForceCommand for sshd
# Called by sshd for every connection from a "gw-*" user.
# Looks up Token -> target IP from SQLite and tunnels via netcat.
# Also notifies the TunnelVault API so SSH sessions appear
# on the dashboard.
# ============================================================

GATEWAY_DIR="/opt/tunnelvault"
DB_PATH="$GATEWAY_DIR/data/tunnelvault.db"
LOG_FILE="/var/log/tunnelvault-gateway.log"
API_URL="http://127.0.0.1:4000"
# Load AUTH_TOKEN from .env for API authentication
ENV_FILE="$GATEWAY_DIR/backend/.env"
AUTH_TOKEN=""
if [[ -f "$ENV_FILE" ]]; then
    AUTH_TOKEN=$(grep -oP '^AUTH_TOKEN=\K.*' "$ENV_FILE" | tr -d "'\"" || true)
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [PID:$$] $*" >> "$LOG_FILE"; }

die() {
    log "DENIED: $*"
    echo "TunnelVault Gateway: $*" >&2
    exit 1
}

# Linux username = "gw-<TOKEN>" -> extract token
LINUX_USER="$USER"
TOKEN="${LINUX_USER#gw-}"
CLIENT_IP=$(echo "$SSH_CLIENT" | awk '{print $1}')

[[ -z "$TOKEN" ]] && die "No token in username: $LINUX_USER"

# ── Input validation (prevent SQL/command injection) ──────
# Tokens must be alphanumeric only
if [[ ! "$TOKEN" =~ ^[a-zA-Z0-9]+$ ]]; then
    die "Invalid token format (alphanumeric only): rejected"
fi

# Client IP must look like an IP address
if [[ -n "$CLIENT_IP" && ! "$CLIENT_IP" =~ ^[0-9a-fA-F.:]+$ ]]; then
    CLIENT_IP="invalid"
fi

log "CONNECT token=$TOKEN client=$CLIENT_IP"

# ── DB Lookup (parameterized via printf %q is not available in sqlite3 CLI,
#    but we validated TOKEN is alphanumeric above, so it is safe) ──────
ROW=$(sqlite3 "$DB_PATH" \
    "SELECT target_ip, target_port, active FROM tokens WHERE token='$TOKEN' LIMIT 1;")

[[ -z "$ROW" ]]   && die "Unknown token: $TOKEN"

TARGET_IP=$(echo "$ROW"   | cut -d'|' -f1)
TARGET_PORT=$(echo "$ROW" | cut -d'|' -f2)
ACTIVE=$(echo "$ROW"      | cut -d'|' -f3)

[[ "$ACTIVE" != "1" ]] && die "Token disabled: $TOKEN"
[[ -z "$TARGET_IP" ]]  && die "No target IP for token: $TOKEN"

# Validate values from DB before using in exec/nc
if [[ ! "$TARGET_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "Invalid target IP in database: rejected"
fi
if [[ ! "$TARGET_PORT" =~ ^[0-9]+$ ]] || (( TARGET_PORT < 1 || TARGET_PORT > 65535 )); then
    die "Invalid target port in database: rejected"
fi

log "ROUTE token=$TOKEN -> $TARGET_IP:$TARGET_PORT"

# ── Update last_seen ──────────────────────────────────────
sqlite3 "$DB_PATH" \
    "UPDATE tokens SET last_seen=datetime('now') WHERE token='$TOKEN';"

# ── Create session via API (single source of truth) ───────
# Falls back to direct SQLite insert if API is unavailable.
AUTH_HEADER=""
if [[ -n "$AUTH_TOKEN" ]]; then
    AUTH_HEADER="Authorization: Bearer ${AUTH_TOKEN}"
fi

SESSION_ID=$(curl -s --max-time 2 \
    -X POST "${API_URL}/api/sessions" \
    -H "Content-Type: application/json" \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    -d "{\"token\":\"${TOKEN}\",\"client_ip\":\"${CLIENT_IP}\",\"pid\":$$}" \
    2>/dev/null | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p') || true

SESSION_VIA_API=true
if [[ -n "$SESSION_ID" ]]; then
    log "SESSION_START id=$SESSION_ID via=api token=$TOKEN -> $TARGET_IP:$TARGET_PORT"
else
    # API unavailable — fall back to direct SQLite
    SESSION_ID=$(sqlite3 "$DB_PATH" \
        "INSERT INTO sessions(token, client_ip, pid)
         VALUES('$TOKEN','$CLIENT_IP',$$);
         SELECT last_insert_rowid();")
    SESSION_VIA_API=false
    log "SESSION_START id=$SESSION_ID via=sqlite token=$TOKEN -> $TARGET_IP:$TARGET_PORT"
fi

# ── Cleanup on disconnect ─────────────────────────────────
cleanup() {
    if [[ "$SESSION_VIA_API" == true && "$SESSION_ID" =~ ^[0-9]+$ ]]; then
        # End session via API
        curl -s --max-time 2 \
            -X PATCH "${API_URL}/api/sessions/${SESSION_ID}" \
            -H "Content-Type: application/json" \
            ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
            2>/dev/null || true
    elif [[ "$SESSION_ID" =~ ^[0-9]+$ ]]; then
        # Fallback: end session directly in SQLite
        sqlite3 "$DB_PATH" \
            "UPDATE sessions SET disconnected_at=datetime('now') WHERE id=$SESSION_ID;"
    fi
    log "SESSION_END id=$SESSION_ID token=$TOKEN"
}
trap cleanup EXIT

# ── Tunnel via netcat ─────────────────────────────────────
# nc forwards raw TCP bytes – the SSH client handshakes directly with the target
exec nc -q0 "$TARGET_IP" "$TARGET_PORT"
