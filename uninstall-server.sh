#!/bin/bash
# ================================================================
# TunnelVault — Server uninstaller
# Usage: sudo bash uninstall-server.sh [--yes] [--no-backup] [--remove-source]
#
# Removes everything install-server.sh created: services and timers
# (tunnelvault, tunnelvault-usermgr, tunnelvault-autoupdate, legacy
# tunnelvault-api), /opt/tunnelvault, gateway users and group, the sshd
# gateway block, sudoers/logrotate files, the nginx site, the certbot
# deploy hook, updater configuration and the TunnelVault firewall rules.
#
# By default the database and configuration (incl. AUTH_TOKEN and
# DATA_ENCRYPTION_KEY) are first saved to /var/backups/tunnelvault/.
# Kept: Let's Encrypt certificates, installed packages (nodejs, nginx,
# certbot, sqlite3, ufw) and the SSH/HTTP/HTTPS firewall rules.
# ================================================================
set -euo pipefail

if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'
    CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; DIM=''; NC=''
fi

step_num=0; TOTAL_STEPS=10
step()    { step_num=$((step_num + 1)); echo ""; echo "${BOLD}${BLUE}[${step_num}/${TOTAL_STEPS}]${NC} ${BOLD}$*${NC}"; }
info()    { echo "  ${GREEN}✓${NC} $*"; }
warn()    { echo "  ${YELLOW}⚠${NC} $*"; }
skipped() { echo "  ${DIM}– $* (skipped)${NC}"; }
fail()    { echo "${RED}$*${NC}" >&2; exit 1; }

INSTALL_DIR="/opt/tunnelvault"
ENV_FILE="${INSTALL_DIR}/backend/.env"
SERVICE_USER="tunnelvault"
GW_GROUP="tunnelvault-gw"
SYSTEMD_DIR="/etc/systemd/system"
SSHD_CONF="/etc/ssh/sshd_config"
SUDOERS_FILE="/etc/sudoers.d/tunnelvault"
LOGROTATE_FILE="/etc/logrotate.d/tunnelvault"
CONF_DIR="/etc/tunnelvault"
NGINX_DIR="/etc/nginx"
ACME_WEBROOT="/var/www/tunnelvault-acme"
DEPLOY_HOOK="/etc/letsencrypt/renewal-hooks/deploy/tunnelvault-reload-nginx.sh"
BACKUP_DIR="/var/backups/tunnelvault"
UNITS=(tunnelvault.service tunnelvault-api.service tunnelvault-usermgr.path tunnelvault-usermgr.service
       tunnelvault-autoupdate.timer tunnelvault-autoupdate.service)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ASSUME_YES=false
BACKUP=true
REMOVE_SOURCE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes)        ASSUME_YES=true ;;
        --no-backup)     BACKUP=false ;;
        --remove-source) REMOVE_SOURCE=true ;;
        -h|--help)
            sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) fail "Unknown option: $1 (see --help)" ;;
    esac
    shift
done

[[ $EUID -eq 0 ]] || fail "Run as root: sudo bash uninstall-server.sh"

confirm() {
    local answer
    $ASSUME_YES && return 0
    read -r -p "  $1 [y/N] " answer || return 1
    [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]
}

# Read a value from the (service-user writable) env file; validated by the caller
env_get() {
    [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || return 0
    grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d "\"' \r" || true
}
is_port() { [[ "${1:-}" =~ ^[1-9][0-9]{0,4}$ ]] && (( $1 <= 65535 )); }

echo ""
echo "${BOLD}${CYAN}  TunnelVault Server Uninstaller${NC}"
echo ""
echo "  ${YELLOW}This removes TunnelVault, its gateway users and its configuration from this server.${NC}"
if $BACKUP; then
    echo "  Database and configuration are saved to ${BACKUP_DIR}/ first (use --no-backup to skip)."
else
    echo "  ${RED}--no-backup: the database, tokens and encryption key will be deleted permanently.${NC}"
fi
echo ""
confirm "Continue?" || { echo "  ${DIM}Aborted.${NC}"; exit 0; }

# Remember what to clean up before the configuration is gone
API_PORT="$(env_get PORT)";        is_port "$API_PORT"   || API_PORT=4000
PROXY_PORT="$(env_get PROXY_PORT)"; is_port "$PROXY_PORT" || PROXY_PORT=4001
TCP_MIN="$(env_get TCP_PORT_MIN)";  is_port "$TCP_MIN"    || TCP_MIN=10000
TCP_MAX="$(env_get TCP_PORT_MAX)";  is_port "$TCP_MAX"    || TCP_MAX=10999
DOMAIN="$(env_get DOMAIN)"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || DOMAIN=""

# ── 1. Stop services ─────────────────────────────────────────
step "Stopping services"
for unit in "${UNITS[@]}"; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1 && [[ -f "${SYSTEMD_DIR}/${unit}" ]]; then
        systemctl disable --now "$unit" >/dev/null 2>&1 || true
        info "Stopped and disabled ${unit}"
    fi
done

# ── 2. Backup ────────────────────────────────────────────────
step "Backing up database and configuration"
BACKUP_FILE=""
if $BACKUP && [[ -d "$INSTALL_DIR" ]]; then
    ts="$(date -u '+%Y%m%d-%H%M%S')"
    mkdir -p "$BACKUP_DIR"; chmod 0700 "$BACKUP_DIR"
    BACKUP_FILE="${BACKUP_DIR}/tunnelvault-backup-${ts}.tar.gz"
    items=()
    for rel in data backend/.env VERSION; do
        if [[ -e "${INSTALL_DIR}/${rel}" ]]; then items+=("$rel"); fi
    done
    if (( ${#items[@]} )); then
        (umask 077; tar -czf "$BACKUP_FILE" -C "$INSTALL_DIR" "${items[@]}")
        chmod 0600 "$BACKUP_FILE"
        info "Saved ${items[*]} to ${BACKUP_FILE}"
        warn "The backup contains AUTH_TOKEN, device tokens and DATA_ENCRYPTION_KEY — keep it private or delete it."
    else
        BACKUP_FILE=""
        skipped "Nothing to back up"
    fi
else
    skipped "Backup"
fi

# ── 3. Remove units ──────────────────────────────────────────
step "Removing systemd units"
removed=0
for unit in "${UNITS[@]}"; do
    if [[ -f "${SYSTEMD_DIR}/${unit}" ]]; then
        rm -f "${SYSTEMD_DIR}/${unit}"
        removed=$((removed + 1))
    fi
done
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true
info "Removed ${removed} unit file(s)"

# ── 4. Legacy SSH gateway ────────────────────────────────────
step "Removing the legacy SSH gateway"
if grep -q "TUNNELVAULT-GATEWAY START" "$SSHD_CONF" 2>/dev/null; then
    backup="$(mktemp)"
    cp -p "$SSHD_CONF" "$backup"
    sed -i '/^# === TUNNELVAULT-GATEWAY START ===/,/^# === TUNNELVAULT-GATEWAY END ===/d' "$SSHD_CONF"
    if ! command -v sshd >/dev/null 2>&1 || sshd -t >/dev/null 2>&1; then
        for u in ssh.service sshd.service; do
            if systemctl cat "$u" >/dev/null 2>&1; then systemctl try-reload-or-restart "$u" || true; break; fi
        done
        info "sshd gateway block removed"
    else
        cat "$backup" > "$SSHD_CONF"
        warn "sshd rejected the configuration without the gateway block — ${SSHD_CONF} left unchanged"
    fi
    rm -f "$backup"
else
    skipped "No TunnelVault block in ${SSHD_CONF}"
fi

GW_USERS="$(getent passwd | awk -F: '$1 ~ /^gw-[A-Za-z0-9]+$/ && $3 != 0 { print $1 }' || true)"
if [[ -n "$GW_USERS" ]]; then
    while IFS= read -r gw_user; do
        pkill -KILL -u "$gw_user" >/dev/null 2>&1 || true
        userdel -r "$gw_user" >/dev/null 2>&1 || userdel -f "$gw_user" >/dev/null 2>&1 || true
    done <<< "$GW_USERS"
    info "Removed $(wc -l <<< "$GW_USERS") gateway user(s) (gw-*)"
else
    skipped "No gateway users"
fi
if getent group "$GW_GROUP" >/dev/null 2>&1; then
    if groupdel "$GW_GROUP" >/dev/null 2>&1; then info "Group ${GW_GROUP} removed"; else warn "Could not remove group ${GW_GROUP}"; fi
fi
for f in "$SUDOERS_FILE" "$LOGROTATE_FILE"; do
    if [[ -f "$f" ]]; then rm -f "$f"; info "Removed ${f}"; fi
done

# ── 5. nginx / Let's Encrypt ─────────────────────────────────
step "Removing the nginx site"
nginx_changed=false
for site in "${NGINX_DIR}/sites-available/tunnelvault" "${NGINX_DIR}/conf.d/tunnelvault.conf"; do
    if [[ -f "$site" ]]; then
        if head -n 3 "$site" | grep -Fq -e "Managed by TunnelVault install-server.sh" -e "auto-generated by install-server.sh"; then
            rm -f "$site"
            nginx_changed=true
            info "Removed ${site}"
        else
            warn "${site} was modified by hand — left in place"
        fi
    fi
done
if [[ -L "${NGINX_DIR}/sites-enabled/tunnelvault" && ! -e "${NGINX_DIR}/sites-enabled/tunnelvault" ]]; then
    rm -f "${NGINX_DIR}/sites-enabled/tunnelvault"
fi
if $nginx_changed && command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
        systemctl try-reload-or-restart nginx >/dev/null 2>&1 || true
        info "nginx reloaded"
    else
        warn "nginx configuration test fails — check 'nginx -t'"
    fi
fi
if [[ -f "$DEPLOY_HOOK" ]]; then rm -f "$DEPLOY_HOOK"; info "Removed certbot deploy hook"; fi
if [[ -d "$ACME_WEBROOT" ]]; then rm -rf "$ACME_WEBROOT"; fi
if [[ -n "$DOMAIN" && -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    echo "  ${DIM}Certificate for ${DOMAIN} kept. Delete it with: certbot delete --cert-name ${DOMAIN}${NC}"
fi

# ── 6. Firewall ──────────────────────────────────────────────
step "Removing firewall rules"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for rule in "${API_PORT}/tcp" "${PROXY_PORT}/tcp" "${TCP_MIN}:${TCP_MAX}/tcp"; do
        if ufw delete allow "$rule" >/dev/null 2>&1; then info "Removed rule ${rule}"; else skipped "Rule ${rule} not present"; fi
    done
    echo "  ${DIM}Rules for 22 (SSH), 80 and 443 were kept on purpose.${NC}"
else
    skipped "ufw not active"
fi

# ── 7. Installation directory ────────────────────────────────
step "Removing ${INSTALL_DIR}"
if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    info "Removed ${INSTALL_DIR}"
else
    skipped "${INSTALL_DIR} not found"
fi

# ── 8. Service user ──────────────────────────────────────────
step "Removing the service user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
    pkill -KILL -u "$SERVICE_USER" >/dev/null 2>&1 || true
    userdel "$SERVICE_USER" >/dev/null 2>&1 || true
    if getent group "$SERVICE_USER" >/dev/null 2>&1; then groupdel "$SERVICE_USER" >/dev/null 2>&1 || true; fi
    info "User '${SERVICE_USER}' removed"
else
    skipped "User '${SERVICE_USER}' not found"
fi

# ── 9. Updater configuration ─────────────────────────────────
step "Removing updater configuration"
if [[ -f "${CONF_DIR}/client.env" || -f "${CONF_DIR}/config.json" || -f "${SYSTEMD_DIR}/tunnelvault-client.service" ]]; then
    skipped "${CONF_DIR} is shared with the TunnelVault client on this host — kept"
elif [[ -d "$CONF_DIR" ]]; then
    rm -f "${CONF_DIR}/update.conf" "${CONF_DIR}/release-signing.pub"
    if rmdir "$CONF_DIR" 2>/dev/null; then info "Removed ${CONF_DIR}"; else warn "${CONF_DIR} is not empty — kept"; fi
else
    skipped "${CONF_DIR} not found"
fi

# ── 10. Source directory ─────────────────────────────────────
step "Source directory"
echo "  Source directory: ${CYAN}${SCRIPT_DIR}${NC}"
if $REMOVE_SOURCE || { ! $ASSUME_YES && confirm "Delete this directory?"; }; then
    if [[ "$SCRIPT_DIR" == "/" || "$SCRIPT_DIR" == "${HOME:-/}" || ! -f "${SCRIPT_DIR}/install-server.sh" ]]; then
        warn "Refusing to delete ${SCRIPT_DIR}"
    else
        cd /
        rm -rf "$SCRIPT_DIR"
        info "Removed ${SCRIPT_DIR}"
    fi
else
    skipped "Source directory kept"
fi

echo ""
echo "${BOLD}${GREEN}  TunnelVault server uninstalled.${NC}"
echo ""
if [[ -n "$BACKUP_FILE" ]]; then
    echo "  Backup:        ${BACKUP_FILE}"
    echo "                 restore: reinstall, stop the service, extract into ${INSTALL_DIR}, fix ownership, start"
fi
if [[ -d "$BACKUP_DIR" ]]; then
    echo "  Older backups: ${BACKUP_DIR}/ (configuration backups made by install-server.sh)"
fi
echo "  Kept:          packages (nodejs, nginx, certbot, sqlite3, ufw), Let's Encrypt certificates,"
echo "                 firewall rules for SSH/HTTP/HTTPS"
echo ""
