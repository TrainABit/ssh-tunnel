#!/bin/bash
# ============================================================
# setup.sh – One-time setup on the Gateway server
# Run as root: sudo bash setup.sh
# ============================================================
set -euo pipefail

GATEWAY_DIR="/opt/tunnelvault"
DB_PATH="$GATEWAY_DIR/data/tunnelvault.db"
LOG_FILE="/var/log/tunnelvault-gateway.log"
API_PORT=4000
PROXY_PORT=4001
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
error() { echo -e "${RED}ERROR:${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && error "Please run as root: sudo bash setup.sh"

# ── System dependencies ──────────────────────────────────
info "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq sqlite3 netcat-openbsd curl ca-certificates gnupg

# ── Install Node.js 20.x via NodeSource ──────────────────
if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null)" != v20.* ]]; then
    info "Installing Node.js 20.x via NodeSource..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
    info "Node.js $(node -v) installed."
else
    info "Node.js $(node -v) already installed."
fi

# ── Create gateway directory structure ───────────────────
info "Creating gateway directory: $GATEWAY_DIR"
mkdir -p "$GATEWAY_DIR/backend"
mkdir -p "$GATEWAY_DIR/frontend"
mkdir -p "$GATEWAY_DIR/data"

# ── Copy gateway scripts ────────────────────────────────
info "Copying gateway scripts..."
cp "$SCRIPT_DIR/ssh_router.sh"       "$GATEWAY_DIR/ssh_router.sh"
cp "$SCRIPT_DIR/register_token.sh"   "$GATEWAY_DIR/register_token.sh"
chmod +x "$GATEWAY_DIR/ssh_router.sh"
chmod +x "$GATEWAY_DIR/register_token.sh"

# ── Copy and install TunnelVault backend ─────────────────
info "Setting up TunnelVault backend..."
cp -r "$PROJECT_ROOT/backend/src"          "$GATEWAY_DIR/backend/src"
cp    "$PROJECT_ROOT/backend/package.json" "$GATEWAY_DIR/backend/package.json"
cp    "$PROJECT_ROOT/backend/package-lock.json" "$GATEWAY_DIR/backend/package-lock.json" 2>/dev/null || true

cd "$GATEWAY_DIR/backend"
npm install --omit=dev --quiet
cd "$SCRIPT_DIR"

# ── Copy built frontend (if available) ───────────────────
if [[ -d "$PROJECT_ROOT/frontend/dist" ]]; then
    info "Copying built frontend..."
    cp -r "$PROJECT_ROOT/frontend/dist" "$GATEWAY_DIR/frontend/dist"
else
    warn "Frontend not built yet. Run 'npm run build' in frontend/ first."
    warn "The API will run without the dashboard UI until the frontend is built."
fi

# ── Initialise SQLite database ───────────────────────────
info "Initialising SQLite database..."
sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT    UNIQUE NOT NULL,
    label       TEXT    NOT NULL DEFAULT '',
    target_ip   TEXT    NOT NULL,
    target_port INTEGER NOT NULL DEFAULT 22,
    public_key  TEXT    NOT NULL DEFAULT '',
    linux_user  TEXT    UNIQUE NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT,
    active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    token            TEXT NOT NULL,
    connected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    disconnected_at  TEXT,
    client_ip        TEXT,
    pid              INTEGER
);
SQL

# ── Configure sshd ──────────────────────────────────────
info "Configuring sshd..."
SSHD_CONF="/etc/ssh/sshd_config"

# Remove old gateway block if present
sed -i '/# === TUNNELVAULT-GATEWAY START ===/,/# === TUNNELVAULT-GATEWAY END ===/d' "$SSHD_CONF"

cat >> "$SSHD_CONF" <<SSHEOF

# === TUNNELVAULT-GATEWAY START ===
AllowTcpForwarding yes
GatewayPorts no

Match User "gw-*"
    ForceCommand $GATEWAY_DIR/ssh_router.sh
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding no
# === TUNNELVAULT-GATEWAY END ===
SSHEOF

sshd -t && systemctl restart sshd
info "sshd restarted."

# ── Create service user (non-root) ───────────────────────
if ! id tunnelvault &>/dev/null; then
    useradd -r -s /bin/false -M tunnelvault
    info "Service user 'tunnelvault' created."
fi
chown -R tunnelvault:tunnelvault "$GATEWAY_DIR/backend"
chown tunnelvault:tunnelvault "$DB_PATH"
chown tunnelvault:tunnelvault "$LOG_FILE"

# ── Systemd service: TunnelVault API ────────────────────
info "Creating systemd service for TunnelVault API..."
ENV_FILE="$GATEWAY_DIR/backend/.env"

# Create .env if it doesn't exist
if [[ ! -f "$ENV_FILE" ]]; then
    GENERATED_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    cat > "$ENV_FILE" <<ENVEOF
PORT=$API_PORT
PROXY_PORT=$PROXY_PORT
DOMAIN=tunnel.local
AUTH_TOKEN=$GENERATED_TOKEN
DB_PATH=$DB_PATH
NODE_ENV=production
LOG_LEVEL=info
LOG_FILE=$LOG_FILE
ENVEOF
    chmod 600 "$ENV_FILE"
    chown tunnelvault:tunnelvault "$ENV_FILE"
    info "Generated .env with AUTH_TOKEN at $ENV_FILE"
    info "AUTH_TOKEN: $GENERATED_TOKEN"
else
    info ".env already exists at $ENV_FILE — preserving"
fi

cat > /etc/systemd/system/tunnelvault-api.service <<EOF
[Unit]
Description=TunnelVault API + Dashboard
After=network.target

[Service]
Type=simple
User=tunnelvault
WorkingDirectory=$GATEWAY_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $GATEWAY_DIR/backend/src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tunnelvault-api

# ── Log file ────────────────────────────────────────────
touch "$LOG_FILE"
chmod 640 "$LOG_FILE"
chown tunnelvault:tunnelvault "$LOG_FILE"

# ── Done ────────────────────────────────────────────────
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "<GATEWAY-IP>")

echo ""
echo -e "${GREEN}+======================================================+${NC}"
echo -e "${GREEN}|        TunnelVault Gateway Setup Complete!            |${NC}"
echo -e "${GREEN}+======================================================+${NC}"
echo -e "${GREEN}|${NC}  Gateway IP:    ${YELLOW}$PUBLIC_IP${NC}"
echo -e "${GREEN}|${NC}  SSH Port:      22"
echo -e "${GREEN}|${NC}  API/Dashboard: http://$PUBLIC_IP:$API_PORT"
echo -e "${GREEN}|${NC}  Proxy Port:    $PROXY_PORT"
echo -e "${GREEN}|${NC}  Logs:          tail -f $LOG_FILE"
echo -e "${GREEN}|${NC}                 journalctl -u tunnelvault-api -f"
echo -e "${GREEN}|${NC}  DB:            $DB_PATH"
echo -e "${GREEN}+------------------------------------------------------+${NC}"
echo -e "${GREEN}|${NC}  Register your first token:"
echo -e "${GREEN}|${NC}  ${YELLOW}$GATEWAY_DIR/register_token.sh \\${NC}"
echo -e "${GREEN}|${NC}  ${YELLOW}  --token mytoken123 --ip 10.0.1.10 \\${NC}"
echo -e "${GREEN}|${NC}  ${YELLOW}  --label 'Dev Server' --pubkey 'ssh-rsa ...'${NC}"
echo -e "${GREEN}+======================================================+${NC}"
