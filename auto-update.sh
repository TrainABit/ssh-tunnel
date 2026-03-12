#!/bin/bash
# ================================================================
# TunnelVault Auto-Updater
# Checks for new Git commits and redeploys if changes are found.
# Installed by install-server.sh — do not run directly.
# ================================================================
set -euo pipefail

INSTALL_DIR="/opt/tunnelvault"
SERVICE_NAME="tunnelvault"
LOG_FILE="${INSTALL_DIR}/logs/auto-update.log"
MAX_LOG_LINES=1000

# SOURCE_DIR is substituted by install-server.sh at install time
SOURCE_DIR="__SOURCE_DIR__"

export PATH="/usr/bin:/usr/local/bin:/usr/local/sbin:$PATH"

# ── Helpers ──────────────────────────────────────────────────────
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log_stdout() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Rotate log if it gets too long
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
log_stdout "Update available"
log_stdout "  Current : ${LOCAL:0:12}"
log_stdout "  Latest  : ${REMOTE:0:12}"

# ── Pull changes ─────────────────────────────────────────────────
log "Pulling changes from origin/main..."
git pull origin main --quiet 2>&1 | while IFS= read -r line; do log "  git: $line"; done

# ── Rebuild frontend ─────────────────────────────────────────────
log "Installing frontend dependencies..."
cd "$SOURCE_DIR/frontend"
npm install --quiet 2>&1 | tail -2 | while IFS= read -r line; do log "  npm: $line"; done

log "Building frontend..."
if npm run build 2>&1 | tail -5 | while IFS= read -r line; do log "  build: $line"; done; then
    log "Frontend built successfully"
else
    log "ERROR: Frontend build failed — aborting update"
    exit 1
fi

cd "$SOURCE_DIR"

# ── Copy backend source ──────────────────────────────────────────
log "Copying backend source..."
rsync -a --delete \
    --exclude='node_modules' \
    "$SOURCE_DIR/backend/src/" "$INSTALL_DIR/backend/src/"

# Copy any root-level backend files (package.json etc.) if changed
rsync -a \
    --exclude='node_modules' \
    --exclude='src' \
    --exclude='.env' \
    "$SOURCE_DIR/backend/" "$INSTALL_DIR/backend/" 2>/dev/null || true

# ── Copy frontend build ──────────────────────────────────────────
log "Copying frontend build..."
rm -rf "$INSTALL_DIR/frontend/dist"
cp -r "$SOURCE_DIR/frontend/dist" "$INSTALL_DIR/frontend/dist"

# ── Fix ownership ────────────────────────────────────────────────
chown -R tunnelvault:tunnelvault "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend" 2>/dev/null || true

# ── Install backend dependencies ─────────────────────────────────
log "Updating backend npm dependencies..."
cd "$INSTALL_DIR/backend"
npm install --omit=dev --quiet 2>&1 | tail -2 | while IFS= read -r line; do log "  npm: $line"; done

# ── Restart service ──────────────────────────────────────────────
log "Restarting ${SERVICE_NAME} service..."
systemctl restart "$SERVICE_NAME"
sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_stdout "Update complete — service running (${REMOTE:0:12})"
else
    log_stdout "ERROR: Service failed to start after update!"
    systemctl status "$SERVICE_NAME" --no-pager --lines=20 2>&1 | while IFS= read -r line; do log "  $line"; done
    exit 1
fi

log_stdout "──────────────────────────────────────────────"
