#!/bin/bash
# ================================================================
# TunnelVault — Client Uninstaller
#
# Usage: sudo bash uninstall-client.sh [--yes] [--keep-config] [--remove-source]
#
#   --yes            do not ask for confirmation
#   --keep-config    keep /etc/tunnelvault/{client.env,config.json}, the reconnect
#                    state in /var/lib/tunnelvault and the service user's ~/.tunnelvault
#                    (token, tunnels and state, so a reinstall keeps the same public ports)
#   --remove-source  also delete the directory this script is in (asked interactively
#                    when --yes is not given)
#
# Removes everything install-client.sh creates: the tunnelvault-client service,
# the auto-updater service/timer (signed and legacy git-based), the remote-reboot
# sudoers rule, /opt/tunnelvault-client (+ .previous), /usr/local/bin/tunnelvault,
# /etc/tunnelvault/{client.env,config.json}, update.conf and release-signing.pub
# (unless the TunnelVault server is installed on this host too — /etc/tunnelvault
# itself is only removed when empty), /var/lib/tunnelvault (reconnect state),
# ~/.tunnelvault of the service user, and the updater log.
# ================================================================
set -Eeuo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

step_num=0; TOTAL_STEPS=5
step()    { step_num=$((step_num + 1)); echo ""; echo -e "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }
info()    { echo -e "  ${GREEN}✓${NC} $*"; }
skipped() { echo -e "  ${DIM}– $* (skipped)${NC}"; }
die()     { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }

# DESTDIR-style prefix used by the test-suite only (see install-client.sh).
TV_ROOT="${TUNNELVAULT_INSTALL_ROOT:-}"
fs() { printf '%s%s' "$TV_ROOT" "$1"; }

SERVICE_NAME="tunnelvault-client"
UPDATER_UNIT="tunnelvault-client-autoupdate"
INSTALL_DIR="/opt/tunnelvault-client"
CONFIG_DIR="/etc/tunnelvault"
SYSTEMD_DIR="/etc/systemd/system"
SUDOERS_FILE="/etc/sudoers.d/tunnelvault-reboot"
CLI_WRAPPER="/usr/local/bin/tunnelvault"
SERVER_INSTALL_DIR="/opt/tunnelvault"
STATE_DIR="/var/lib/tunnelvault"

ASSUME_YES=false
KEEP_CONFIG=false
REMOVE_SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)        ASSUME_YES=true; shift ;;
    --keep-config)   KEEP_CONFIG=true; shift ;;
    --remove-source) REMOVE_SOURCE=yes; shift ;;
    -h|--help)       awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Unknown option: $(printf '%q' "$1")" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash uninstall-client.sh"

ask() {  # ask "question" -> 0 for yes
  local answer=""
  read -r -p "  $1 [y/N] " answer || true
  [[ ${answer,,} == y || ${answer,,} == yes ]]
}

remove_path() {  # remove_path PATH LABEL
  local p
  p=$(fs "$1")
  if [[ -e $p || -L $p ]]; then
    rm -rf -- "$p"
    info "Removed ${2:-$1}"
  fi
}

echo ""
echo -e "${BOLD}${CYAN}  TunnelVault Client Uninstaller${NC}"
[[ -z $TV_ROOT ]] || echo -e "  TEST MODE: removing below ${TV_ROOT}"
echo ""
if ! $ASSUME_YES && ! ask "Remove the TunnelVault client and its service?"; then
  echo -e "\n  ${DIM}Aborted.${NC}"
  exit 0
fi

# Read the service user before the unit file disappears.
SERVICE_USER=""
UNIT_FILE=$(fs "${SYSTEMD_DIR}/${SERVICE_NAME}.service")
if [[ -f $UNIT_FILE ]]; then
  SERVICE_USER=$(sed -n 's/^[[:space:]]*User[[:space:]]*=[[:space:]]*\([A-Za-z0-9_.-]*\)[[:space:]]*$/\1/p' "$UNIT_FILE" | tail -n 1)
fi

# ── Step 1: services ────────────────────────────────────────────────
step "Stopping and removing systemd units"
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "${UPDATER_UNIT}.timer" >/dev/null 2>&1 || true
  systemctl stop "${UPDATER_UNIT}.service" >/dev/null 2>&1 || true
  systemctl stop 'tunnelvault-client-restart-*.timer' >/dev/null 2>&1 || true
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME" || true
    info "Service stopped"
  else
    skipped "Service was not running"
  fi
  systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
fi
units_removed=false
for unit in "${SERVICE_NAME}.service" "${UPDATER_UNIT}.service" "${UPDATER_UNIT}.timer"; do
  if [[ -e $(fs "${SYSTEMD_DIR}/${unit}") ]]; then
    rm -f -- "$(fs "${SYSTEMD_DIR}/${unit}")"
    info "Removed ${SYSTEMD_DIR}/${unit}"
    units_removed=true
  fi
done
if $units_removed && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
$units_removed || skipped "No unit files found"
remove_path "$SUDOERS_FILE" "remote-reboot sudoers rule ${SUDOERS_FILE}"

# ── Step 2: code ────────────────────────────────────────────────────
step "Removing the CLI and installed files"
remove_path "$CLI_WRAPPER"
remove_path "$INSTALL_DIR"
remove_path "${INSTALL_DIR}.previous"
remove_path "${INSTALL_DIR}.new"
remove_path "/var/log/tunnelvault-client-update.log"
remove_path "/var/log/tunnelvault-client-update.log.tmp"
remove_path "/run/tunnelvault-client-update.lock"
remove_path "/run/tunnelvault-client-install.lock"

# ── Step 3: system configuration ────────────────────────────────────
step "Removing configuration (${CONFIG_DIR})"
if $KEEP_CONFIG; then
  skipped "Kept ${CONFIG_DIR}/client.env and config.json (--keep-config)"
else
  remove_path "${CONFIG_DIR}/client.env" "${CONFIG_DIR}/client.env (device token)"
  remove_path "${CONFIG_DIR}/config.json"
fi
SERVER_PRESENT=false
if [[ -d $(fs "$SERVER_INSTALL_DIR") || -f $(fs "${SYSTEMD_DIR}/tunnelvault.service") ]]; then
  SERVER_PRESENT=true
fi
if $SERVER_PRESENT; then
  skipped "TunnelVault server found on this host — kept ${CONFIG_DIR}/update.conf and release-signing.pub"
else
  remove_path "${CONFIG_DIR}/update.conf"
  remove_path "${CONFIG_DIR}/release-signing.pub"
fi
if [[ -d $(fs "$CONFIG_DIR") && ! -L $(fs "$CONFIG_DIR") ]] && rmdir -- "$(fs "$CONFIG_DIR")" 2>/dev/null; then
  info "Removed empty ${CONFIG_DIR}"
fi

# ── Step 4: reconnect state ─────────────────────────────────────────
step "Removing reconnect state (${STATE_DIR}, ~/.tunnelvault)"
if $KEEP_CONFIG; then
  skipped "Kept ${STATE_DIR} and ~/.tunnelvault (--keep-config)"
else
  remove_path "$STATE_DIR" "${STATE_DIR} (reconnect state)"
  declare -A seen_home=()
  for user in "$SERVICE_USER" "${SUDO_USER:-}"; do
    [[ -n $user ]] || continue
    home=$(getent passwd "$user" | cut -d: -f6 || true)
    [[ $home == /* && $home != / && -z ${seen_home[$home]:-} ]] || continue
    seen_home[$home]=1
    dir="$(fs "$home")/.tunnelvault"
    if [[ -L $dir ]]; then
      skipped "${home}/.tunnelvault is a symlink — not following it"
    elif [[ -d $dir ]]; then
      rm -rf -- "$dir"
      info "Removed ${home}/.tunnelvault (config + reconnect state)"
    fi
  done
fi

# ── Step 5: source directory ────────────────────────────────────────
step "Source directory"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z $REMOVE_SOURCE ]] && ! $ASSUME_YES; then
  echo -e "  Source directory: ${CYAN}${SCRIPT_DIR}${NC}"
  if ask "Delete this directory?"; then REMOVE_SOURCE=yes; fi
fi
if [[ $REMOVE_SOURCE == yes ]]; then
  if [[ $SCRIPT_DIR == / || ! -f "${SCRIPT_DIR}/install-client.sh" || ! -d "${SCRIPT_DIR}/client" ]]; then
    die "refusing to delete ${SCRIPT_DIR} (does not look like a TunnelVault source tree)"
  fi
  cd /
  rm -rf -- "$SCRIPT_DIR"
  info "Removed ${SCRIPT_DIR}"
else
  skipped "Source directory kept"
fi

echo ""
echo -e "${BOLD}${GREEN}  TunnelVault client uninstalled.${NC}"
echo -e "  ${DIM}Revoke the device token in the dashboard (Tokens) if it will not be reused.${NC}"
echo ""
