#!/bin/bash
# ============================================================
# register_token.sh – Create / manage gateway tokens
# Usage: sudo bash register_token.sh --token TOKEN --ip 10.0.1.10 ...
# ============================================================

GATEWAY_DIR="/opt/tunnelvault"
DB_PATH="$GATEWAY_DIR/data/tunnelvault.db"

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Create / update a token:
  --token    TOKEN    Token string (required)
  --ip       IP       Target IP in VPC (required, e.g. 10.0.1.10)
  --port     PORT     Target SSH port (default: 22)
  --label    TEXT     Description (e.g. "Dev Server")
  --pubkey   KEY      SSH public key of the client (required for auth)

Disable a token:
  --disable  TOKEN    Disable token (connections will be refused)

Delete a token:
  --delete   TOKEN    Completely remove token + Linux user

List tokens:
  --list              Show all tokens

Example:
  $0 --token xK9mQp --ip 10.0.1.42 --label "Acme Corp Dev" \\
     --pubkey "ssh-rsa AAAAB3Nza..."
EOF
    exit 1
}

[[ $EUID -ne 0 ]] && { echo "Please run as root."; exit 1; }
[[ $# -eq 0 ]] && usage

TOKEN=""; TARGET_IP=""; TARGET_PORT=22; LABEL=""; PUBKEY=""
DISABLE=""; DELETE=""; LIST=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --token)   TOKEN="$2";      shift 2;;
        --ip)      TARGET_IP="$2";  shift 2;;
        --port)    TARGET_PORT="$2";shift 2;;
        --label)   LABEL="$2";      shift 2;;
        --pubkey)  PUBKEY="$2";     shift 2;;
        --disable) DISABLE="$2";    shift 2;;
        --delete)  DELETE="$2";     shift 2;;
        --list)    LIST=1;          shift;;
        *)         usage;;
    esac
done

# ── List ──────────────────────────────────────────────────
if [[ $LIST -eq 1 ]]; then
    echo "TOKEN                    LABEL                IP              PORT  ACTIVE LAST SEEN"
    echo "------------------------------------------------------------------------------------"
    sqlite3 -separator $'\t' "$DB_PATH" \
        "SELECT token, label, target_ip, target_port, active, COALESCE(last_seen,'never') FROM tokens ORDER BY created_at DESC;" \
    | awk -F'\t' '{printf "%-24s %-20s %-15s %-5s %-6s %s\n",$1,$2,$3,$4,($5=="1"?"yes":"NO"),$6}'
    exit 0
fi

# ── Input validation helper ────────────────────────────────
validate_token_format() {
    local t="$1"
    if [[ ! "$t" =~ ^[a-zA-Z0-9]+$ ]]; then
        echo "Error: Token must be alphanumeric only. Got: '$t'"
        exit 1
    fi
}

validate_ip_format() {
    local ip="$1"
    if [[ ! "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: Invalid IP address format: '$ip'"
        exit 1
    fi
}

validate_port_format() {
    local port="$1"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
        echo "Error: Invalid port number: '$port'"
        exit 1
    fi
}

# Escape single quotes for safe SQL string interpolation
sql_escape() {
    echo "${1//\'/\'\'}"
}

# ── Disable ───────────────────────────────────────────────
if [[ -n "$DISABLE" ]]; then
    validate_token_format "$DISABLE"
    sqlite3 "$DB_PATH" "UPDATE tokens SET active=0 WHERE token='$(sql_escape "$DISABLE")';"
    echo "Token '$DISABLE' disabled. Active connections will be refused."
    exit 0
fi

# ── Delete ────────────────────────────────────────────────
if [[ -n "$DELETE" ]]; then
    validate_token_format "$DELETE"
    ESCAPED_DELETE=$(sql_escape "$DELETE")
    LINUX_USER=$(sqlite3 "$DB_PATH" "SELECT linux_user FROM tokens WHERE token='$ESCAPED_DELETE';")
    sqlite3 "$DB_PATH" "DELETE FROM tokens WHERE token='$ESCAPED_DELETE';"
    sqlite3 "$DB_PATH" "DELETE FROM sessions WHERE token='$ESCAPED_DELETE';"
    if [[ -n "$LINUX_USER" && "$LINUX_USER" =~ ^gw-[a-zA-Z0-9]+$ ]]; then
        userdel -r "$LINUX_USER" 2>/dev/null || true
        echo "Linux user '$LINUX_USER' removed."
    fi
    echo "Token '$DELETE' completely deleted."
    exit 0
fi

# ── Create / Update ──────────────────────────────────────
[[ -z "$TOKEN" ]]     && { echo "Error: --token is required"; usage; }
[[ -z "$TARGET_IP" ]] && { echo "Error: --ip is required";    usage; }
[[ -z "$PUBKEY" ]]    && { echo "Error: --pubkey is required (SSH public key)"; usage; }

# Validate all inputs
validate_token_format "$TOKEN"
validate_ip_format "$TARGET_IP"
validate_port_format "$TARGET_PORT"

# Validate SSH public key format
if [[ ! "$PUBKEY" =~ ^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+|ssh-dss)[[:space:]] ]]; then
    echo "Error: Invalid SSH public key format (must start with ssh-rsa, ssh-ed25519, etc.)"
    exit 1
fi
if [[ "$PUBKEY" == *$'\n'* ]] || [[ "$PUBKEY" == *$'\r'* ]] || [[ "$PUBKEY" == *'`'* ]] || [[ "$PUBKEY" == *'$('* ]]; then
    echo "Error: Public key contains invalid characters"
    exit 1
fi

LINUX_USER="gw-${TOKEN}"

# Validate linux user format before using in system commands
if [[ ! "$LINUX_USER" =~ ^gw-[a-zA-Z0-9]+$ ]]; then
    echo "Error: Invalid linux user derived from token"
    exit 1
fi

# Create Linux user if it doesn't exist
if ! id "$LINUX_USER" &>/dev/null; then
    useradd -r -s /bin/false -m "$LINUX_USER"
    echo "Linux user '$LINUX_USER' created."
fi

# Set up ~/.ssh/authorized_keys
SSH_DIR="/home/$LINUX_USER/.ssh"
mkdir -p "$SSH_DIR"
echo "$PUBKEY" > "$SSH_DIR/authorized_keys"
chown -R "$LINUX_USER":"$LINUX_USER" "$SSH_DIR"
chmod 700 "$SSH_DIR"
chmod 600 "$SSH_DIR/authorized_keys"

# DB: INSERT OR REPLACE — escape values for SQL safety
ESCAPED_TOKEN=$(sql_escape "$TOKEN")
ESCAPED_LABEL=$(sql_escape "$LABEL")
ESCAPED_IP=$(sql_escape "$TARGET_IP")
ESCAPED_PUBKEY=$(sql_escape "$PUBKEY")
ESCAPED_LINUX_USER=$(sql_escape "$LINUX_USER")

sqlite3 "$DB_PATH" <<SQL
INSERT INTO tokens (token, label, target_ip, target_port, public_key, linux_user)
VALUES ('$ESCAPED_TOKEN', '$ESCAPED_LABEL', '$ESCAPED_IP', $TARGET_PORT, '$ESCAPED_PUBKEY', '$ESCAPED_LINUX_USER')
ON CONFLICT(token) DO UPDATE SET
    label       = excluded.label,
    target_ip   = excluded.target_ip,
    target_port = excluded.target_port,
    public_key  = excluded.public_key,
    active      = 1;
SQL

GATEWAY_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo "<GATEWAY-IP>")

echo ""
echo "Token registered successfully"
echo "---------------------------------------------------------"
echo "  Token:      $TOKEN"
echo "  Linux User: $LINUX_USER"
echo "  Target:     $TARGET_IP:$TARGET_PORT"
echo "  Label:      $LABEL"
echo ""
echo "  Client ~/.ssh/config entry:"
echo ""
echo "  Host <alias>"
echo "      HostName $GATEWAY_IP"
echo "      User $LINUX_USER"
echo "      IdentityFile ~/.ssh/id_rsa"
echo ""
echo "  Connect: ssh <alias>"
echo "---------------------------------------------------------"
