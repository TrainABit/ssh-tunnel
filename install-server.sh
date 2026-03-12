#!/bin/bash
# ================================================================
# TunnelVault — Server Installation Script
# Usage: sudo bash install-server.sh [OPTIONS]
#
# Options:
#   --domain DOMAIN       Set the server domain (default: tunnel.local)
#   --auth-token TOKEN    Set the API auth token (auto-generated if omitted)
#   --port PORT           Set the API port (default: 4000)
#   --proxy-port PORT     Set the proxy port (default: 4001)
#   --upgrade             Upgrade existing installation (preserves DB & config)
#   --tls                 Enable automatic Nginx + Let's Encrypt TLS setup
#
# Example:
#   sudo bash install-server.sh --domain tunnel.example.com
#   sudo bash install-server.sh --domain tunnel.example.com --tls
# ================================================================
set -euo pipefail

# ─── Colors & Helpers ────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

TOTAL_STEPS=13
step_num=0

# Adjusted after argument parsing (see below)

step() {
    step_num=$((step_num + 1))
    echo ""
    echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"
    echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"
}

info()    { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; exit 1; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }

# ─── Constants ───────────────────────────────────────────────────
INSTALL_DIR="/opt/tunnelvault"
DATA_DIR="${INSTALL_DIR}/data"
LOG_DIR="${INSTALL_DIR}/logs"
DB_PATH="${DATA_DIR}/tunnelvault.db"
ENV_FILE="${INSTALL_DIR}/backend/.env"
SERVICE_NAME="tunnelvault"
SERVICE_USER="tunnelvault"
SSHD_CONF="/etc/ssh/sshd_config"

# Locate project source (same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Defaults ────────────────────────────────────────────────────
DOMAIN="tunnel.local"
AUTH_TOKEN=""
API_PORT=4000
PROXY_PORT=4001
UPGRADE=false
ENABLE_TLS=false

# ─── Parse Arguments ────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)       DOMAIN="$2";     shift 2 ;;
        --auth-token)   AUTH_TOKEN="$2";  shift 2 ;;
        --port)         API_PORT="$2";    shift 2 ;;
        --proxy-port)   PROXY_PORT="$2";  shift 2 ;;
        --upgrade)      UPGRADE=true;     shift   ;;
        --tls)          ENABLE_TLS=true;  shift   ;;
        -h|--help)
            head -n 18 "$0" | tail -n +2 | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            echo "Run with --help for usage information."
            exit 1
            ;;
    esac
done

# Adjust total steps if TLS is enabled
if $ENABLE_TLS; then
    TOTAL_STEPS=13
fi

# ─── Banner ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║                                                      ║"
echo "  ║            TunnelVault Server Installer              ║"
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
if $UPGRADE; then
    echo -e "  ${YELLOW}Mode: UPGRADE (preserving database & configuration)${NC}"
else
    echo -e "  ${DIM}Mode: Fresh install${NC}"
fi
echo ""

# ================================================================
# STEP 1 — Pre-flight Checks
# ================================================================
step "Pre-flight checks"

# Must be root
if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root. Use: sudo bash install-server.sh"
fi
info "Running as root"

# Must be Debian/Ubuntu
if ! command -v apt-get &>/dev/null; then
    fail "This script requires a Debian/Ubuntu system (apt-get not found)"
fi
info "Debian/Ubuntu detected"

# Check for existing installation
if [[ -d "$INSTALL_DIR" ]] && ! $UPGRADE; then
    if [[ -f "$ENV_FILE" ]]; then
        warn "Existing TunnelVault installation detected at ${INSTALL_DIR}"
        echo ""
        echo -e "  ${YELLOW}To upgrade without losing data, run:${NC}"
        echo -e "  ${BOLD}sudo bash install-server.sh --upgrade${NC}"
        echo ""
        read -r -p "  Continue with fresh install? This will OVERWRITE config. [y/N] " confirm
        if [[ "${confirm,,}" != "y" ]]; then
            echo -e "\n  ${DIM}Aborted.${NC}"
            exit 0
        fi
    fi
elif $UPGRADE && [[ ! -d "$INSTALL_DIR" ]]; then
    warn "No existing installation found — performing fresh install instead"
    UPGRADE=false
fi

if $UPGRADE; then
    info "Upgrade mode: database and configuration will be preserved"
else
    info "Fresh install confirmed"
fi

# Validate source files exist
if [[ ! -d "${SCRIPT_DIR}/backend/src" ]]; then
    fail "Cannot find backend/src relative to this script (${SCRIPT_DIR}). Run from the project root."
fi
info "Source files located at ${SCRIPT_DIR}"

# ================================================================
# STEP 2 — System Dependencies
# ================================================================
step "Installing system dependencies"

apt-get update -qq 2>&1 | tail -1
info "Package lists updated"

PACKAGES=(sqlite3 netcat-openbsd curl ca-certificates gnupg ufw)
for pkg in "${PACKAGES[@]}"; do
    if dpkg -s "$pkg" &>/dev/null; then
        skipped "$pkg already installed"
    else
        apt-get install -y -qq "$pkg" > /dev/null 2>&1
        info "$pkg installed"
    fi
done

# ================================================================
# STEP 3 — Node.js 20.x
# ================================================================
step "Ensuring Node.js 20.x is installed"

if command -v node &>/dev/null && [[ "$(node -v 2>/dev/null)" == v20.* ]]; then
    info "Node.js $(node -v) already installed"
else
    if command -v node &>/dev/null; then
        warn "Found Node.js $(node -v) — replacing with 20.x"
    fi
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq 2>/dev/null
    apt-get install -y -qq nodejs > /dev/null 2>&1
    info "Node.js $(node -v) installed"
fi

# Verify npm is available
if ! command -v npm &>/dev/null; then
    fail "npm not found after Node.js installation"
fi
info "npm $(npm -v) available"

# ================================================================
# STEP 4 — Create Service User
# ================================================================
step "Creating service user"

if id "$SERVICE_USER" &>/dev/null; then
    skipped "User '${SERVICE_USER}' already exists"
else
    useradd -r -s /usr/sbin/nologin -d "$INSTALL_DIR" -M "$SERVICE_USER"
    info "System user '${SERVICE_USER}' created"
fi

# ================================================================
# STEP 5 — Directory Structure
# ================================================================
step "Setting up directory structure"

dirs=(
    "$INSTALL_DIR"
    "${INSTALL_DIR}/backend"
    "${INSTALL_DIR}/frontend/dist"
    "$DATA_DIR"
    "$LOG_DIR"
)

for d in "${dirs[@]}"; do
    mkdir -p "$d"
    skipped "$d"
done
info "All directories created"

# ================================================================
# STEP 6 — Copy Project Files
# ================================================================
step "Copying project files"

# Backend source
rm -rf "${INSTALL_DIR}/backend/src"
cp -r "${SCRIPT_DIR}/backend/src" "${INSTALL_DIR}/backend/src"
info "Backend source copied"

# Backend package files
cp "${SCRIPT_DIR}/backend/package.json" "${INSTALL_DIR}/backend/package.json"
if [[ -f "${SCRIPT_DIR}/backend/package-lock.json" ]]; then
    cp "${SCRIPT_DIR}/backend/package-lock.json" "${INSTALL_DIR}/backend/package-lock.json"
fi
info "Package manifests copied"

# Frontend (always rebuild so --upgrade picks up UI changes)
echo -e "  ${DIM}Building frontend...${NC}"
cd "${SCRIPT_DIR}/frontend"
if npm install --quiet 2>&1 | tail -3 && npm run build 2>&1 | tail -5; then
    info "Frontend built successfully"
else
    warn "Frontend build failed — Dashboard UI may be unavailable"
    warn "Run manually: cd ${SCRIPT_DIR}/frontend && npm install && npm run build"
fi
cd "$SCRIPT_DIR"

if [[ -d "${SCRIPT_DIR}/frontend/dist" ]]; then
    rm -rf "${INSTALL_DIR}/frontend/dist"
    cp -r "${SCRIPT_DIR}/frontend/dist" "${INSTALL_DIR}/frontend/dist"
    info "Frontend build copied"
else
    warn "Frontend build failed — Dashboard UI will be unavailable"
fi

# Gateway scripts
for script in ssh_router.sh register_token.sh manage-user.sh; do
    if [[ -f "${SCRIPT_DIR}/gateway/${script}" ]]; then
        cp "${SCRIPT_DIR}/gateway/${script}" "${INSTALL_DIR}/${script}"
        chown root:root "${INSTALL_DIR}/${script}"
        chmod 755 "${INSTALL_DIR}/${script}"
        info "Gateway script: ${script}"
    else
        warn "Gateway script not found: ${script}"
    fi
done

# Sudoers: allow tunnelvault user to run manage-user.sh as root
if [[ -f "${SCRIPT_DIR}/gateway/tunnelvault-sudoers" ]]; then
    cp "${SCRIPT_DIR}/gateway/tunnelvault-sudoers" /etc/sudoers.d/tunnelvault
    chown root:root /etc/sudoers.d/tunnelvault
    chmod 440 /etc/sudoers.d/tunnelvault
    info "Sudoers rule installed for manage-user.sh"
else
    warn "tunnelvault-sudoers not found — API won't be able to manage Linux users"
fi

# Install Node.js dependencies
echo -e "  ${DIM}Installing npm dependencies (production only)...${NC}"
cd "${INSTALL_DIR}/backend"
npm install --omit=dev --quiet 2>&1 | tail -3
cd "$SCRIPT_DIR"
info "npm dependencies installed"

# ================================================================
# STEP 7 — Generate Configuration
# ================================================================
step "Generating configuration"

if $UPGRADE && [[ -f "$ENV_FILE" ]]; then
    info "Preserving existing configuration at ${ENV_FILE}"
    # Source existing values so we can display them later
    # shellcheck disable=SC1090
    source <(grep -E '^(PORT|PROXY_PORT|DOMAIN|AUTH_TOKEN)=' "$ENV_FILE" 2>/dev/null || true)
    API_PORT="${PORT:-$API_PORT}"
    AUTH_TOKEN="${AUTH_TOKEN:-}"
else
    # Generate auth token if not provided
    if [[ -z "$AUTH_TOKEN" ]]; then
        AUTH_TOKEN="$(openssl rand -hex 32)"
        info "Auth token auto-generated (64-char hex)"
    else
        info "Using provided auth token"
    fi

    cat > "$ENV_FILE" <<ENVEOF
PORT=${API_PORT}
PROXY_PORT=${PROXY_PORT}
TCP_PORT_MIN=10000
TCP_PORT_MAX=10999
DOMAIN=${DOMAIN}
AUTH_TOKEN=${AUTH_TOKEN}
DB_PATH=${DB_PATH}
NODE_ENV=production

# Logging (levels: debug, info, warn, error)
LOG_LEVEL=info
LOG_FILE=${LOG_DIR}/tunnelvault.log
# LOG_FORMAT=json  # uncomment for structured JSON logs

# TLS (optional — set if using built-in HTTPS instead of Nginx)
# TLS_CERT=/path/to/fullchain.pem
# TLS_KEY=/path/to/privkey.pem

# Webhook notifications (optional — fires when tunnels connect/disconnect)
# WEBHOOK_URL=https://ntfy.sh/your-topic
# WEBHOOK_TYPE=ntfy   # ntfy | slack | discord | json (default: json)
ENVEOF

    # Add active TLS env vars when --tls is used
    if $ENABLE_TLS; then
        cat >> "$ENV_FILE" <<ENVEOF
TLS_CERT=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/${DOMAIN}/privkey.pem
ENVEOF
    fi

    chmod 600 "$ENV_FILE"
    info "Configuration written to ${ENV_FILE}"
fi

# ================================================================
# STEP 8 — Initialize Database
# ================================================================
step "Initializing database"

if $UPGRADE && [[ -f "$DB_PATH" ]]; then
    info "Existing database preserved at ${DB_PATH}"
    # Run migrations (CREATE IF NOT EXISTS is idempotent)
fi

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
    token            TEXT,
    connected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    disconnected_at  TEXT,
    client_ip        TEXT,
    target_ip        TEXT,
    target_port      INTEGER,
    pid              INTEGER
);
CREATE TABLE IF NOT EXISTS tunnels (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    subdomain         TEXT NOT NULL,
    local_port        INTEGER NOT NULL DEFAULT 3000,
    public_url        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'inactive',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    connections       INTEGER NOT NULL DEFAULT 0,
    bytes_transferred INTEGER NOT NULL DEFAULT 0
);
SQL

info "Database ready at ${DB_PATH}"

# ================================================================
# STEP 9 — Configure SSH Gateway
# ================================================================
step "Configuring SSH gateway"

# Remove any existing TunnelVault sshd block
if grep -q "TUNNELVAULT-GATEWAY START" "$SSHD_CONF" 2>/dev/null; then
    sed -i '/# === TUNNELVAULT-GATEWAY START ===/,/# === TUNNELVAULT-GATEWAY END ===/d' "$SSHD_CONF"
    info "Removed previous SSH gateway configuration"
fi

cat >> "$SSHD_CONF" <<SSHEOF

# === TUNNELVAULT-GATEWAY START ===
AllowTcpForwarding yes
GatewayPorts no

Match User "gw-*"
    ForceCommand ${INSTALL_DIR}/ssh_router.sh
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding no
# === TUNNELVAULT-GATEWAY END ===
SSHEOF

# Validate config before restarting
if sshd -t 2>/dev/null; then
    info "SSH configuration valid"
    systemctl restart sshd
    info "sshd restarted"
else
    fail "SSH configuration test failed — check ${SSHD_CONF} manually"
fi

# ================================================================
# STEP 10 — Create Systemd Service
# ================================================================
step "Creating systemd service"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=TunnelVault API + Dashboard
After=network.target
Documentation=https://github.com/tunnelvault/tunnelvault

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/backend
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${INSTALL_DIR}/backend/src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tunnelvault

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR} ${LOG_DIR}
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
info "Service file created"

# Enable and (re)start
if $UPGRADE; then
    systemctl restart "$SERVICE_NAME"
    info "Service restarted"
else
    systemctl enable --now "$SERVICE_NAME"
    info "Service enabled and started"
fi

# ================================================================
# STEP 11 — Install Auto-Updater
# ================================================================
step "Installing auto-updater"

# Write the auto-update script with the actual source path substituted
sed "s|__SOURCE_DIR__|${SCRIPT_DIR}|g" "${SCRIPT_DIR}/auto-update.sh" > "${INSTALL_DIR}/auto-update.sh"
chmod 755 "${INSTALL_DIR}/auto-update.sh"
info "Auto-update script installed at ${INSTALL_DIR}/auto-update.sh"

# Systemd one-shot service
cat > "/etc/systemd/system/tunnelvault-autoupdate.service" <<EOF
[Unit]
Description=TunnelVault Auto-Updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/auto-update.sh
User=root
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tunnelvault-update
EOF

# Systemd timer — runs every 5 minutes
cat > "/etc/systemd/system/tunnelvault-autoupdate.timer" <<EOF
[Unit]
Description=TunnelVault Auto-Update Timer
Requires=tunnelvault-autoupdate.service

[Timer]
OnBootSec=5min
OnUnitActiveSec=12h
AccuracySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now tunnelvault-autoupdate.timer
info "Auto-updater timer enabled (checks every 12h)"

# ================================================================
# STEP 12 — Configure Firewall (ufw)
# ================================================================
step "Configuring firewall"

ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow 22/tcp comment "SSH" > /dev/null 2>&1
info "Allowed port 22 (SSH)"
ufw allow "${API_PORT}/tcp" comment "TunnelVault API" > /dev/null 2>&1
info "Allowed port ${API_PORT} (API + Dashboard)"
ufw allow "${PROXY_PORT}/tcp" comment "TunnelVault Proxy" > /dev/null 2>&1
info "Allowed port ${PROXY_PORT} (Proxy)"
ufw allow 10000:10999/tcp comment "TunnelVault TCP tunnels" > /dev/null 2>&1
info "Allowed ports 10000-10999 (TCP tunnels)"
if $ENABLE_TLS; then
    ufw allow 80/tcp comment "HTTP (redirect to HTTPS)" > /dev/null 2>&1
    info "Allowed port 80 (HTTP redirect)"
    ufw allow 443/tcp comment "HTTPS" > /dev/null 2>&1
    info "Allowed port 443 (HTTPS)"
fi
ufw --force enable > /dev/null 2>&1
info "Firewall enabled"

# ================================================================
# STEP — Nginx + Let's Encrypt TLS (conditional)
# ================================================================
if $ENABLE_TLS; then
    step "Setting up Nginx + Let's Encrypt TLS"

    # Install nginx and certbot
    for pkg in nginx certbot python3-certbot-nginx; do
        if dpkg -s "$pkg" &>/dev/null; then
            skipped "$pkg already installed"
        else
            apt-get install -y -qq "$pkg" > /dev/null 2>&1
            info "$pkg installed"
        fi
    done

    # Generate Nginx configuration
    cat > /etc/nginx/sites-available/tunnelvault <<NGINXEOF
# TunnelVault — auto-generated by install-server.sh

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} *.${DOMAIN};
    return 301 https://\$host\$request_uri;
}

# Main dashboard / API
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://127.0.0.1:${API_PORT}/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}

# Wildcard subdomain proxy
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name *.${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:${PROXY_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXEOF

    info "Nginx config written to /etc/nginx/sites-available/tunnelvault"

    # Enable site
    ln -sf /etc/nginx/sites-available/tunnelvault /etc/nginx/sites-enabled/tunnelvault
    rm -f /etc/nginx/sites-enabled/default
    info "Site enabled (default site removed)"

    # Test nginx config
    if nginx -t 2>/dev/null; then
        info "Nginx configuration valid"
    else
        warn "Nginx config test failed — will attempt to continue"
    fi

    # Obtain certificate with certbot
    echo -e "  ${DIM}Requesting Let's Encrypt certificate for ${DOMAIN}...${NC}"
    if certbot --nginx -d "${DOMAIN}" -d "*.${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email 2>&1 | tail -3; then
        info "SSL certificate obtained"
    else
        warn "Certbot failed — you may need to run certbot manually"
        warn "Try: certbot --nginx -d ${DOMAIN} -d '*.${DOMAIN}'"
    fi

    # Reload nginx
    systemctl enable nginx
    systemctl reload nginx 2>/dev/null || systemctl start nginx
    info "Nginx running"
fi

# ================================================================
# STEP 13 — Set Permissions & Finalize
# ================================================================
step "Setting permissions"

chown -R "${SERVICE_USER}:${SERVICE_USER}" "$DATA_DIR"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$LOG_DIR"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/backend"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/frontend"
chown "${SERVICE_USER}:${SERVICE_USER}" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Gateway scripts need root ownership (called by sshd)
for script in ssh_router.sh register_token.sh; do
    if [[ -f "${INSTALL_DIR}/${script}" ]]; then
        chown root:root "${INSTALL_DIR}/${script}"
        chmod 755 "${INSTALL_DIR}/${script}"
    fi
done

info "File ownership and permissions set"

# Touch log file
touch "${LOG_DIR}/tunnelvault.log"
chown "${SERVICE_USER}:${SERVICE_USER}" "${LOG_DIR}/tunnelvault.log"

# ================================================================
# FINAL — Summary
# ================================================================
echo ""

PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "<SERVER-IP>")
SERVICE_STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown")

if [[ "$SERVICE_STATUS" == "active" ]]; then
    STATUS_COLOR="${GREEN}"
    STATUS_TEXT="RUNNING"
else
    STATUS_COLOR="${RED}"
    STATUS_TEXT="$SERVICE_STATUS"
fi

echo -e "${BOLD}${GREEN}"
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║                                                      ║"
if $UPGRADE; then
echo "  ║         TunnelVault Upgrade Complete!                ║"
else
echo "  ║       TunnelVault Installation Complete!             ║"
fi
echo "  ║                                                      ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}Server Details${NC}"
echo -e "  ────────────────────────────────────────────────────"
echo -e "  Public IP:       ${CYAN}${PUBLIC_IP}${NC}"
if $ENABLE_TLS; then
echo -e "  Dashboard:       ${CYAN}https://${DOMAIN}${NC}"
echo -e "  API Base:        ${CYAN}https://${DOMAIN}/api${NC}"
else
echo -e "  Dashboard:       ${CYAN}http://${PUBLIC_IP}:${API_PORT}${NC}"
echo -e "  API Base:        ${CYAN}http://${PUBLIC_IP}:${API_PORT}/api${NC}"
fi
echo -e "  Proxy Port:      ${CYAN}${PROXY_PORT}${NC}"
echo -e "  SSH Gateway:     ${CYAN}Port 22${NC}"
echo -e "  Service Status:  ${STATUS_COLOR}${STATUS_TEXT}${NC}"
echo -e "  Auto-Updater:    ${GREEN}every 12h (git pull)${NC}"
echo ""
echo -e "  ${BOLD}${YELLOW}Auth Token (save this — it won't be shown again):${NC}"
echo -e "  ────────────────────────────────────────────────────"
echo -e "  ${BOLD}${AUTH_TOKEN}${NC}"
echo ""
echo -e "  ${BOLD}Useful Commands${NC}"
echo -e "  ────────────────────────────────────────────────────"
echo -e "  ${DIM}View logs:${NC}       journalctl -u ${SERVICE_NAME} -f"
echo -e "  ${DIM}Update logs:${NC}     tail -f ${INSTALL_DIR}/logs/auto-update.log"
echo -e "  ${DIM}Force update:${NC}    ${INSTALL_DIR}/auto-update.sh"
echo -e "  ${DIM}Service status:${NC}  systemctl status ${SERVICE_NAME}"
echo -e "  ${DIM}Restart:${NC}         systemctl restart ${SERVICE_NAME}"
echo -e "  ${DIM}Register token:${NC}  ${INSTALL_DIR}/register_token.sh \\"
echo -e "                   --token mytoken --ip 10.0.1.10 \\"
echo -e "                   --label 'My Server' --pubkey 'ssh-rsa ...'"
echo -e "  ${DIM}View config:${NC}     cat ${ENV_FILE}"
echo -e "  ${DIM}View database:${NC}   sqlite3 ${DB_PATH} '.tables'"
echo ""
echo -e "  ${BOLD}Next Steps${NC}"
echo -e "  ────────────────────────────────────────────────────"
echo -e "  1. Point your domain (${CYAN}${DOMAIN}${NC}) DNS A record to ${CYAN}${PUBLIC_IP}${NC}"
if $ENABLE_TLS; then
echo -e "  2. ${GREEN}TLS is configured${NC} via Nginx + Let's Encrypt"
else
echo -e "  2. Set up TLS (e.g., Caddy or Nginx reverse proxy with Let's Encrypt)"
echo -e "     Or re-run with --tls: ${CYAN}sudo bash install-server.sh --domain ${DOMAIN} --tls${NC}"
fi
echo -e "  3. Register your first tunnel token using the command above"
echo -e "  4. Connect from your client: ${CYAN}ssh -R 0:localhost:80 gw-<user>@${PUBLIC_IP}${NC}"
echo ""
echo -e "  ${DIM}────────────────────────────────────────────────────${NC}"
echo -e "  ${DIM}Installation directory: ${INSTALL_DIR}${NC}"
echo -e "  ${DIM}Config file:           ${ENV_FILE}${NC}"
echo -e "  ${DIM}Database:              ${DB_PATH}${NC}"
echo -e "  ${DIM}Logs:                  ${LOG_DIR}/${NC}"
echo ""
