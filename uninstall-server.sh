#!/bin/bash
# ================================================================
# TunnelVault — Server Uninstaller
# Usage: sudo bash uninstall-server.sh
# ================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step_num=0; TOTAL_STEPS=8
step()  { step_num=$((step_num + 1)); echo ""; echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }
info()  { echo -e "  ${GREEN}✓${NC} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $*"; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }

INSTALL_DIR="/opt/tunnelvault"
SERVICE_NAME="tunnelvault"
SERVICE_USER="tunnelvault"
SSHD_CONF="/etc/ssh/sshd_config"

[[ $EUID -ne 0 ]] && echo -e "${RED}Run as root: sudo bash uninstall-server.sh${NC}" && exit 1

echo ""
echo -e "${BOLD}${CYAN}  TunnelVault Server Uninstaller${NC}"
echo ""
echo -e "  ${YELLOW}This will remove TunnelVault and all its data from this server.${NC}"
echo ""
read -r -p "  Continue? [y/N] " confirm
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

# ── Step 2: Remove installation directory ───────────────────
step "Removing installation directory"
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    info "Removed ${INSTALL_DIR}"
else
    skipped "${INSTALL_DIR} not found"
fi

# ── Step 3: Remove service user ─────────────────────────────
step "Removing service user"
if id "$SERVICE_USER" &>/dev/null; then
    userdel "$SERVICE_USER" 2>/dev/null || true
    info "User '${SERVICE_USER}' removed"
else
    skipped "User '${SERVICE_USER}' not found"
fi

# ── Step 4: Remove sudoers rule ─────────────────────────────
step "Removing sudoers rule"
if [[ -f "/etc/sudoers.d/tunnelvault" ]]; then
    rm -f /etc/sudoers.d/tunnelvault
    info "Sudoers rule removed"
else
    skipped "Sudoers rule not found"
fi

# ── Step 5: Clean up SSH config ──────────────────────────────
step "Removing SSH gateway configuration"
if grep -q "TUNNELVAULT-GATEWAY START" "$SSHD_CONF" 2>/dev/null; then
    sed -i '/# === TUNNELVAULT-GATEWAY START ===/,/# === TUNNELVAULT-GATEWAY END ===/d' "$SSHD_CONF"
    systemctl restart sshd
    info "SSH gateway config removed and sshd restarted"
else
    skipped "No TunnelVault SSH config found"
fi

# ── Step 6: Remove gw- Linux users ──────────────────────────
step "Removing gateway Linux users (gw-*)"
GW_USERS=$(getent passwd | awk -F: '$1 ~ /^gw-/ {print $1}' || true)
if [[ -n "$GW_USERS" ]]; then
    while IFS= read -r gw_user; do
        userdel -r "$gw_user" 2>/dev/null || userdel "$gw_user" 2>/dev/null || true
        info "Removed user: ${gw_user}"
    done <<< "$GW_USERS"
else
    skipped "No gw-* users found"
fi

# ── Step 7: Remove firewall rules ───────────────────────────
step "Removing firewall rules"
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    ufw delete allow 4000/tcp > /dev/null 2>&1 && info "Removed rule: 4000/tcp" || skipped "Rule 4000/tcp not found"
    ufw delete allow 4001/tcp > /dev/null 2>&1 && info "Removed rule: 4001/tcp" || skipped "Rule 4001/tcp not found"
    ufw delete allow 10000:10999/tcp > /dev/null 2>&1 && info "Removed rule: 10000-10999/tcp" || skipped "Rule 10000-10999/tcp not found"
else
    skipped "ufw not active"
fi

# ── Step 8: Remove source directory ─────────────────────────
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
echo -e "${BOLD}${GREEN}  TunnelVault server uninstalled successfully.${NC}"
echo ""
echo -e "  ${DIM}Note: Port 22 (SSH) firewall rule was intentionally kept.${NC}"
echo ""
