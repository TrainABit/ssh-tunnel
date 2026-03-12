#!/bin/bash
# ================================================================
# TunnelVault — Client Installer
# Usage: sudo bash install-client.sh --server ws://SERVER:4000 --token TOKEN
#
# Options:
#   --server URL    TunnelVault server WebSocket URL (required for fresh install)
#   --token TOKEN   Per-client auth token from dashboard (required for fresh install)
#   --port PORT     Local port to tunnel (default: 22 for SSH)
#   --protocol PROTO Tunnel protocol: http or tcp (default: tcp)
#   --user USER     Linux user to install service as (default: current user or pi)
#   --upgrade       Upgrade existing install — preserves config, only updates code
# ================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step_num=0
TOTAL_STEPS=5
step() { step_num=$((step_num + 1)); echo ""; echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }
info()    { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; exit 1; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }

SERVER_URL=""
AUTH_TOKEN=""
LOCAL_PORT=22
PROTOCOL="tcp"
SERVICE_USER="${SUDO_USER:-${USER:-pi}}"
UPGRADE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)   SERVER_URL="$2";   shift 2 ;;
    --token)    AUTH_TOKEN="$2";   shift 2 ;;
    --port)     LOCAL_PORT="$2";   shift 2 ;;
    --protocol) PROTOCOL="$2";     shift 2 ;;
    --user)     SERVICE_USER="$2"; shift 2 ;;
    --upgrade)  UPGRADE=true;      shift   ;;
    -h|--help) head -n 16 "$0" | tail -n +2 | sed 's/^# \?//'; exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

[[ $EUID -ne 0 ]] && fail "Run as root: sudo bash install-client.sh ..."

INSTALL_DIR="/opt/tunnelvault-client"
CONFIG_DIR="/etc/tunnelvault"
SERVICE_NAME="tunnelvault-client"

# ── Upgrade mode: load existing config ───────────────────────
if $UPGRADE; then
  TOTAL_STEPS=4
  if [[ ! -d "$INSTALL_DIR" ]]; then
    warn "No existing installation found — performing fresh install instead"
    UPGRADE=false
  else
    # Load existing config so we don't need --server/--token on upgrade
    if [[ -f "${CONFIG_DIR}/config.json" ]]; then
      SERVER_URL=$(python3 -c "import json,sys; d=json.load(open('${CONFIG_DIR}/config.json')); print(d.get('server',''))" 2>/dev/null || true)
      AUTH_TOKEN=$(python3 -c "import json,sys; d=json.load(open('${CONFIG_DIR}/config.json')); print(d.get('auth_token',''))" 2>/dev/null || true)
    fi
    info "Upgrade mode: preserving existing config"
  fi
fi

if ! $UPGRADE; then
  [[ -z "$SERVER_URL" ]] && fail "--server is required (e.g. ws://1.2.3.4:4000)"
  [[ -z "$AUTH_TOKEN" ]] && fail "--token is required (get it from the dashboard)"
fi

echo ""
echo -e "${BOLD}${CYAN}  TunnelVault Client Installer${NC}"
if $UPGRADE; then
  echo -e "  ${DIM}Mode: UPGRADE (preserving config)${NC}"
else
  echo -e "  ${DIM}Mode: Fresh install${NC}"
fi
echo ""

# ── Step 1: Node.js ──────────────────────────────────────────
step "Ensuring Node.js 20.x is installed"
if command -v apt-get &>/dev/null; then
  if command -v node &>/dev/null && [[ "$(node -v 2>/dev/null)" == v20.* ]]; then
    info "Node.js $(node -v) already installed"
  else
    apt-get update -qq 2>&1 | tail -1
    apt-get install -y -qq ca-certificates curl gnupg > /dev/null 2>&1
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq 2>/dev/null
    apt-get install -y -qq nodejs > /dev/null 2>&1
    info "Node.js $(node -v) installed"
  fi
else
  command -v node &>/dev/null || fail "Node.js not found. Install it manually: https://nodejs.org"
  info "Node.js $(node -v) found"
fi

# ── Step 2: Copy client files ────────────────────────────────
step "Updating TunnelVault client files"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -d "${SCRIPT_DIR}/client" ]]; then
  fail "client/ directory not found. Run this script from the TunnelVault project root."
fi

# Check if we're likely running over a tunnel (service is active)
# If so, do NOT stop first — copy files while old process runs, then schedule restart
TUNNEL_ACTIVE=false
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  TUNNEL_ACTIVE=true
  warn "Tunnel service is running — files will be updated live, restart scheduled after"
fi

mkdir -p "$INSTALL_DIR"
rsync -a --exclude='node_modules' "${SCRIPT_DIR}/client/" "$INSTALL_DIR/" 2>/dev/null \
  || { cp -r "${SCRIPT_DIR}/client/." "$INSTALL_DIR/"; rm -rf "${INSTALL_DIR}/node_modules"; }

cd "$INSTALL_DIR"
echo -e "  ${DIM}Running npm install...${NC}"
if ! npm install --omit=dev 2>&1; then
  fail "npm install failed — see output above"
fi
chmod +x "${INSTALL_DIR}/bin/tunnelvault.js"

cat > /usr/local/bin/tunnelvault <<WRAPEOF
#!/bin/bash
exec node ${INSTALL_DIR}/bin/tunnelvault.js "\$@"
WRAPEOF
chmod +x /usr/local/bin/tunnelvault
info "tunnelvault CLI updated at /usr/local/bin/tunnelvault"

# ── Step 3: Write config (skipped on upgrade) ────────────────
if $UPGRADE; then
  step "Configuration (preserved)"
  skipped "Config unchanged at ${CONFIG_DIR}/config.json"
else
  step "Writing configuration"
  mkdir -p "$CONFIG_DIR"
  cat > "${CONFIG_DIR}/config.json" <<CFGEOF
{
  "server": "${SERVER_URL}",
  "auth_token": "${AUTH_TOKEN}",
  "protocol": "${PROTOCOL}",
  "port": ${LOCAL_PORT}
}
CFGEOF
  chmod 600 "${CONFIG_DIR}/config.json"
  info "Config written to ${CONFIG_DIR}/config.json"

  if id "$SERVICE_USER" &>/dev/null; then
    USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    if [[ -n "$USER_HOME" && -d "$USER_HOME" ]]; then
      mkdir -p "${USER_HOME}/.tunnelvault"
      cp "${CONFIG_DIR}/config.json" "${USER_HOME}/.tunnelvault/config.json"
      chown -R "${SERVICE_USER}:${SERVICE_USER}" "${USER_HOME}/.tunnelvault"
      info "Config also written to ${USER_HOME}/.tunnelvault/config.json"
    fi
  fi
fi

# ── Step 4: Create / reload systemd service ──────────────────
step "Configuring service"
if ! $UPGRADE; then
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<SVCEOF
[Unit]
Description=TunnelVault Client — SSH tunnel to server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=/usr/local/bin/tunnelvault connect ${LOCAL_PORT} --protocol ${PROTOCOL} --server ${SERVER_URL} --auth-token ${AUTH_TOKEN}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tunnelvault-client

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  info "Service file created and enabled"
fi

# ── Step 5: Start / schedule restart ────────────────────────
step "Applying update"

RESTART_DELAY=30

if $TUNNEL_ACTIVE; then
  # Running over a live tunnel — schedule restart in background so this SSH
  # session can exit cleanly before the tunnel drops.
  # shellcheck disable=SC2064
  (sleep $RESTART_DELAY && systemctl restart "$SERVICE_NAME") &
  disown

  echo ""
  echo -e "  ${BOLD}${YELLOW}⚠  Your SSH session will disconnect in ~${RESTART_DELAY} seconds${NC}"
  echo -e "  ${DIM}The tunnel service is restarting to apply the update.${NC}"
  echo -e "  ${DIM}After it reconnects, SSH in again normally.${NC}"
  echo ""
else
  # Not running over a tunnel (or fresh install) — restart immediately
  systemctl daemon-reload
  systemctl restart "$SERVICE_NAME" 2>/dev/null || systemctl start "$SERVICE_NAME"
  sleep 3
  STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown")
  if [[ "$STATUS" == "active" ]]; then
    info "Service is running"
  else
    warn "Service status: $STATUS — check with: journalctl -u ${SERVICE_NAME} -f"
  fi
fi

# ── Summary ─────────────────────────────────────────────────
echo ""
if $UPGRADE; then
  echo -e "${BOLD}${GREEN}  TunnelVault Client Upgrade Complete!${NC}"
else
  echo -e "${BOLD}${GREEN}  TunnelVault Client Installation Complete!${NC}"
fi
echo ""
echo -e "  ${BOLD}Useful Commands${NC}"
echo -e "  ────────────────────────────────────────────────────"
echo -e "  ${DIM}View logs:${NC}      journalctl -u ${SERVICE_NAME} -f"
echo -e "  ${DIM}Restart:${NC}        systemctl restart ${SERVICE_NAME}"
echo -e "  ${DIM}Stop:${NC}           systemctl stop ${SERVICE_NAME}"
echo -e "  ${DIM}Upgrade next time:${NC} git pull && sudo bash install-client.sh --upgrade"
echo ""
echo -e "  ${DIM}Once connected, the SSH port will be shown in the dashboard.${NC}"
echo ""
