#!/bin/bash
# ================================================================
# TunnelVault — Client Uninstaller
# Usage: sudo bash uninstall-client.sh
# ================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step_num=0; TOTAL_STEPS=5
step()    { step_num=$((step_num + 1)); echo ""; echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }
info()    { echo -e "  ${GREEN}✓${NC} $*"; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }

SERVICE_NAME="tunnelvault-client"
INSTALL_DIR="/opt/tunnelvault-client"

[[ $EUID -ne 0 ]] && echo -e "${RED}Run as root: sudo bash uninstall-client.sh${NC}" && exit 1

echo ""
echo -e "${BOLD}${CYAN}  TunnelVault Client Uninstaller${NC}"
echo ""
read -r -p "  Remove TunnelVault client and its service? [y/N] " confirm
[[ "${confirm,,}" != "y" ]] && echo -e "\n  ${DIM}Aborted.${NC}" && exit 0

# ── Step 1: Stop and disable service ────────────────────────
step "Stopping and removing systemd service"
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
    info "Service stopped"
else
    skipped "Service was not running"
fi
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl disable "$SERVICE_NAME"
    info "Service disabled"
fi
if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    info "Service file removed"
else
    skipped "Service file not found"
fi

# ── Step 2: Remove CLI and install directory ─────────────────
step "Removing CLI and installation files"
if [[ -f "/usr/local/bin/tunnelvault" ]]; then
    rm -f /usr/local/bin/tunnelvault
    info "Removed /usr/local/bin/tunnelvault"
else
    skipped "/usr/local/bin/tunnelvault not found"
fi
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    info "Removed ${INSTALL_DIR}"
else
    skipped "${INSTALL_DIR} not found"
fi

# ── Step 3: Remove system config ────────────────────────────
step "Removing configuration"
if [[ -d "/etc/tunnelvault" ]]; then
    rm -rf /etc/tunnelvault
    info "Removed /etc/tunnelvault"
else
    skipped "/etc/tunnelvault not found"
fi

# ── Step 4: Remove user config ──────────────────────────────
step "Removing user config (~/.tunnelvault)"
# Remove for the user who called sudo, and common device users
for user_home in "$HOME" "/home/pi" "/home/ubuntu"; do
    config_dir="${user_home}/.tunnelvault"
    if [[ -d "$config_dir" ]]; then
        rm -rf "$config_dir"
        info "Removed ${config_dir}"
    fi
done

# ── Step 5: Remove source directory ─────────────────────────
step "Removing source/repo directory"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "  Source directory: ${CYAN}${SCRIPT_DIR}${NC}"
read -r -p "  Delete this directory? [y/N] " rm_src
if [[ "${rm_src,,}" == "y" ]]; then
    cd / && rm -rf "$SCRIPT_DIR"
    info "Removed ${SCRIPT_DIR}"
else
    skipped "Source directory kept"
fi

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  TunnelVault client uninstalled successfully.${NC}"
echo ""
