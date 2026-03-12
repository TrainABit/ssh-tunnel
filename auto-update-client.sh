#!/bin/bash
# ================================================================
# TunnelVault Client Auto-Updater
# Checks for new Git commits and updates the client if changes found.
# Installed by install-client.sh — do not run directly.
# ================================================================
set -euo pipefail

INSTALL_DIR="/opt/tunnelvault-client"
SERVICE_NAME="tunnelvault-client"
LOG_FILE="/var/log/tunnelvault-client-update.log"
MAX_LOG_LINES=500
RESTART_DELAY=30

# SOURCE_DIR is substituted by install-client.sh at install time
SOURCE_DIR="__SOURCE_DIR__"

export PATH="/usr/bin:/usr/local/bin:/usr/local/sbin:$PATH"

# ── Helpers ──────────────────────────────────────────────────────
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log_stdout() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Rotate log if too long
if [[ -f "$LOG_FILE" ]] && [[ $(wc -l < "$LOG_FILE") -gt $MAX_LOG_LINES ]]; then
    tail -n $((MAX_LOG_LINES / 2)) "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

# ── Sanity checks ────────────────────────────────────────────────
if [[ ! -d "$SOURCE_DIR" ]]; then
    log "ERROR: Source directory not found: $SOURCE_DIR"
    exit 1
fi

cd "$SOURCE_DIR"

if ! git rev-parse --git-dir &>/dev/null; then
    log "ERROR: $SOURCE_DIR is not a git repository"
    exit 1
fi

# ── Check for updates ────────────────────────────────────────────
git fetch origin main --quiet 2>/dev/null || {
    log "WARNING: git fetch failed (no internet or remote unavailable)"
    exit 0
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")

if [[ -z "$REMOTE" || "$LOCAL" == "$REMOTE" ]]; then
    exit 0  # Up to date — nothing to do
fi

log_stdout "──────────────────────────────────────────────"
log_stdout "Client update available"
log_stdout "  Current : ${LOCAL:0:12}"
log_stdout "  Latest  : ${REMOTE:0:12}"

# ── Check if package.json changed ────────────────────────────────
PKG_CHANGED=false
if git diff HEAD origin/main -- client/package.json | grep -q '^[-+]'; then
    PKG_CHANGED=true
    log "package.json has changes"
fi

# ── Check if tunnel is active (running over this tunnel) ─────────
TUNNEL_ACTIVE=false
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    TUNNEL_ACTIVE=true
    log "Tunnel service is currently active"
fi

# If package.json changed and we're on a live tunnel, skip — unsafe
if $PKG_CHANGED && $TUNNEL_ACTIVE; then
    log "WARNING: package.json changed but tunnel is active — skipping update."
    log "  Connect directly (not via tunnel) and run: git pull && sudo bash install-client.sh --upgrade"
    exit 0
fi

# ── Pull changes ─────────────────────────────────────────────────
log "Pulling changes from origin/main..."
git pull origin main --quiet 2>&1 | while IFS= read -r line; do log "  git: $line"; done

# ── Copy client files ─────────────────────────────────────────────
log "Copying client files to $INSTALL_DIR..."
rsync -a --exclude='node_modules' "${SOURCE_DIR}/client/" "$INSTALL_DIR/" 2>/dev/null \
  || cp -r "${SOURCE_DIR}/client/." "$INSTALL_DIR/"

chmod +x "${INSTALL_DIR}/bin/tunnelvault.js"

# Update CLI wrapper
cat > /usr/local/bin/tunnelvault <<WRAPEOF
#!/bin/bash
exec node ${INSTALL_DIR}/bin/tunnelvault.js "\$@"
WRAPEOF
chmod +x /usr/local/bin/tunnelvault

# ── npm install if package.json changed ──────────────────────────
if $PKG_CHANGED; then
    log "Installing updated npm dependencies..."
    cd "$INSTALL_DIR"
    if npm install --omit=dev --quiet 2>&1 | tail -2 | while IFS= read -r line; do log "  npm: $line"; done; then
        log "npm install complete"
    else
        log "ERROR: npm install failed"
        exit 1
    fi
    cd "$SOURCE_DIR"
fi

# ── Restart service ──────────────────────────────────────────────
if $TUNNEL_ACTIVE; then
    # Schedule restart in background so the active SSH session can exit cleanly
    (sleep $RESTART_DELAY && systemctl restart "$SERVICE_NAME") &
    disown
    log_stdout "Update applied — tunnel service restart scheduled in ${RESTART_DELAY}s"
else
    systemctl daemon-reload
    systemctl restart "$SERVICE_NAME" 2>/dev/null || systemctl start "$SERVICE_NAME"
    sleep 3

    STATUS=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "unknown")
    if [[ "$STATUS" == "active" ]]; then
        log_stdout "Update complete — service running (${REMOTE:0:12})"
    else
        log_stdout "WARNING: Service status after update: $STATUS"
        log_stdout "  Check with: journalctl -u ${SERVICE_NAME} -f"
    fi
fi

log_stdout "──────────────────────────────────────────────"
