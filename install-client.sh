#!/bin/bash
# TunnelVault — Client Installation Script
# Usage: bash install-client.sh [--server ws://your-server:4000] [--auth-token YOUR_TOKEN]
#        bash install-client.sh --uninstall

set -euo pipefail

# ─── Colors & helpers ──────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { printf "${CYAN}  [*]${RESET} %s\n" "$1"; }
success() { printf "${GREEN}  [✓]${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}  [!]${RESET} %s\n" "$1"; }
fail()    { printf "${RED}  [✗]${RESET} %s\n" "$1"; exit 1; }
step()    { printf "\n${BOLD}  ── Step %s: %s ──${RESET}\n\n" "$1" "$2"; }

box_line() {
    local text="$1"
    local width=62
    local stripped
    stripped=$(printf "%s" "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local len=${#stripped}
    local pad=$((width - len - 4))
    if [ "$pad" -lt 0 ]; then pad=0; fi
    printf "  ║ %s%*s ║\n" "$text" "$pad" ""
}

box_top()    { printf "  ╔"; printf '═%.0s' $(seq 1 60); printf "╗\n"; }
box_mid()    { printf "  ╠"; printf '═%.0s' $(seq 1 60); printf "╣\n"; }
box_bottom() { printf "  ╚"; printf '═%.0s' $(seq 1 60); printf "╝\n"; }

# ─── Parse arguments ──────────────────────────────────────────────────────────

ARG_SERVER=""
ARG_TOKEN=""
INSTALL_DIR="${HOME}/.tunnelvault"
DO_UNINSTALL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)
            ARG_SERVER="$2"; shift 2 ;;
        --auth-token)
            ARG_TOKEN="$2"; shift 2 ;;
        --install-dir)
            INSTALL_DIR="$2"; shift 2 ;;
        --uninstall)
            DO_UNINSTALL=1; shift ;;
        -h|--help)
            printf "Usage: bash install-client.sh [OPTIONS]\n\n"
            printf "Options:\n"
            printf "  --server <url>       Tunnel server URL (e.g. ws://myserver:4000)\n"
            printf "  --auth-token <token> Authentication token\n"
            printf "  --install-dir <dir>  Installation directory (default: ~/.tunnelvault)\n"
            printf "  --uninstall          Remove TunnelVault client\n"
            printf "  -h, --help           Show this help\n"
            exit 0 ;;
        *)
            fail "Unknown option: $1  (use --help for usage)" ;;
    esac
done

# ─── Detect OS ─────────────────────────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "macos" ;;
        *)       echo "unknown" ;;
    esac
}

OS=$(detect_os)

# ─── Uninstall ─────────────────────────────────────────────────────────────────

if [ "$DO_UNINSTALL" -eq 1 ]; then
    printf "\n${BOLD}  TunnelVault — Uninstall${RESET}\n\n"

    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        success "Removed $INSTALL_DIR"
    else
        info "Install directory not found ($INSTALL_DIR), skipping"
    fi

    # Remove symlink from /usr/local/bin
    if [ -L /usr/local/bin/tunnelvault ]; then
        if [ -w /usr/local/bin ]; then
            rm -f /usr/local/bin/tunnelvault
        else
            sudo rm -f /usr/local/bin/tunnelvault
        fi
        success "Removed /usr/local/bin/tunnelvault symlink"
    fi

    # Remove symlink from ~/bin
    if [ -L "${HOME}/bin/tunnelvault" ]; then
        rm -f "${HOME}/bin/tunnelvault"
        success "Removed ~/bin/tunnelvault symlink"
    fi

    printf "\n"
    success "TunnelVault client has been uninstalled."
    printf "\n"
    exit 0
fi

# ─── Banner ────────────────────────────────────────────────────────────────────

printf "\n"
box_top
box_line "${BOLD}TunnelVault${RESET} — Client Installer"
box_line "${DIM}Expose local servers to the internet${RESET}"
box_bottom
printf "\n"

info "Detected OS: ${BOLD}${OS}${RESET}"

if [ "$OS" = "unknown" ]; then
    fail "Unsupported operating system. TunnelVault requires Linux or macOS."
fi

# ─── Step 1: Pre-flight checks ────────────────────────────────────────────────

step "1" "Pre-flight checks"

# ── Locate the source client directory (relative to this script) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_SRC="${SCRIPT_DIR}/client"

if [ ! -d "$CLIENT_SRC" ]; then
    fail "Cannot find client source at ${CLIENT_SRC}. Run this script from the TunnelVault repo root."
fi
success "Found client source at ${CLIENT_SRC}"

# ── Check Node.js ──
check_node() {
    if command -v node &>/dev/null; then
        local ver
        ver=$(node -v | sed 's/v//')
        local major
        major=$(echo "$ver" | cut -d. -f1)
        if [ "$major" -ge 18 ]; then
            success "Node.js v${ver} found"
            return 0
        else
            warn "Node.js v${ver} found but >= 18 is required"
            return 1
        fi
    else
        return 1
    fi
}

install_node() {
    info "Node.js >= 18 not found — installing Node.js 20.x..."
    if [ "$OS" = "macos" ]; then
        if command -v brew &>/dev/null; then
            brew install node
        else
            fail "Homebrew not found. Install it from https://brew.sh then re-run this script."
        fi
    elif command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
            | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
        sudo apt-get update -qq > /dev/null 2>&1
        sudo apt-get install -y nodejs > /dev/null 2>&1
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    else
        fail "Could not detect a supported package manager. Please install Node.js >= 18 manually."
    fi
}

if ! check_node; then
    install_node
    if ! check_node; then
        fail "Node.js >= 18 still not available after install. Please install it manually and retry."
    fi
fi

# ── Check npm ──
if command -v npm &>/dev/null; then
    success "npm $(npm -v) found"
else
    fail "npm not found. Try running: sudo apt-get install -y npm"
fi

# ─── Step 2: Install client ───────────────────────────────────────────────────

step "2" "Install client"

# Create install directory
mkdir -p "${INSTALL_DIR}"
info "Install directory: ${INSTALL_DIR}"

# Copy client files
info "Copying client files..."
mkdir -p "${INSTALL_DIR}/bin"
mkdir -p "${INSTALL_DIR}/src"

cp "${CLIENT_SRC}/package.json" "${INSTALL_DIR}/package.json"
cp "${CLIENT_SRC}/bin/tunnelvault.js" "${INSTALL_DIR}/bin/tunnelvault.js"
cp "${CLIENT_SRC}/src/tunnel.js" "${INSTALL_DIR}/src/tunnel.js"
cp "${CLIENT_SRC}/src/display.js" "${INSTALL_DIR}/src/display.js"

# Copy any other src files that exist
for f in "${CLIENT_SRC}/src/"*.js; do
    [ -f "$f" ] && cp "$f" "${INSTALL_DIR}/src/"
done

chmod +x "${INSTALL_DIR}/bin/tunnelvault.js"
success "Client files copied"

# Run npm install
info "Installing npm dependencies..."
(cd "${INSTALL_DIR}" && npm install --production 2>&1) | while IFS= read -r line; do
    printf "  ${DIM}  %s${RESET}\n" "$line"
done
success "Dependencies installed"

# Create symlink
SYMLINK_PATH=""
if [ -w /usr/local/bin ]; then
    ln -sf "${INSTALL_DIR}/bin/tunnelvault.js" /usr/local/bin/tunnelvault
    SYMLINK_PATH="/usr/local/bin/tunnelvault"
    success "Symlink created: /usr/local/bin/tunnelvault"
elif command -v sudo &>/dev/null; then
    printf "\n  Creating symlink in /usr/local/bin/ requires sudo.\n"
    printf "  ${DIM}Press Enter to continue or Ctrl+C to skip${RESET}\n"
    read -r
    if sudo ln -sf "${INSTALL_DIR}/bin/tunnelvault.js" /usr/local/bin/tunnelvault 2>/dev/null; then
        SYMLINK_PATH="/usr/local/bin/tunnelvault"
        success "Symlink created: /usr/local/bin/tunnelvault"
    else
        warn "Could not write to /usr/local/bin, falling back to ~/bin/"
    fi
fi

if [ -z "$SYMLINK_PATH" ]; then
    mkdir -p "${HOME}/bin"
    ln -sf "${INSTALL_DIR}/bin/tunnelvault.js" "${HOME}/bin/tunnelvault"
    SYMLINK_PATH="${HOME}/bin/tunnelvault"
    success "Symlink created: ~/bin/tunnelvault"

    # Check if ~/bin is in PATH
    if [[ ":$PATH:" != *":${HOME}/bin:"* ]]; then
        warn "~/bin is not in your PATH."
        info "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        printf "\n    export PATH=\"\$HOME/bin:\$PATH\"\n\n"
    fi
fi

# ─── Step 3: Configuration ────────────────────────────────────────────────────

step "3" "Configuration"

CONFIG_FILE="${INSTALL_DIR}/config.json"

if [ -f "$CONFIG_FILE" ]; then
    info "Existing config found at ${CONFIG_FILE}"
    printf "  Overwrite? [y/N]: "
    read -r overwrite
    if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
        info "Keeping existing configuration"
        # Read existing values for later use
        if command -v node &>/dev/null; then
            ARG_SERVER="${ARG_SERVER:-$(node -e "try{const c=JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8'));console.log(c.server||'')}catch{}" 2>/dev/null || echo "")}"
            ARG_TOKEN="${ARG_TOKEN:-$(node -e "try{const c=JSON.parse(require('fs').readFileSync('${CONFIG_FILE}','utf8'));console.log(c.auth_token||'')}catch{}" 2>/dev/null || echo "")}"
        fi
    fi
fi

# If values not provided via flags, prompt interactively
if [ -z "$ARG_SERVER" ]; then
    printf "\n"
    printf "  ${CYAN}Server URL${RESET}\n"
    printf "  ${DIM}The WebSocket URL of your TunnelVault server${RESET}\n"
    printf "  ${DIM}Example: ws://myserver.example.com:4000${RESET}\n\n"
    printf "  Server URL [ws://localhost:4000]: "
    read -r ARG_SERVER
    ARG_SERVER="${ARG_SERVER:-ws://localhost:4000}"
fi

if [ -z "$ARG_TOKEN" ]; then
    printf "\n"
    printf "  ${CYAN}Auth Token${RESET}\n"
    printf "  ${DIM}Your authentication token for the tunnel server${RESET}\n"
    printf "  ${DIM}Leave blank if the server does not require auth${RESET}\n\n"
    printf "  Auth Token []: "
    read -r ARG_TOKEN
fi

# Write config
cat > "$CONFIG_FILE" <<CFGJSON
{
  "server": "${ARG_SERVER}",
  "auth_token": "${ARG_TOKEN}"
}
CFGJSON

success "Configuration saved to ${CONFIG_FILE}"

# ─── Step 4: SSH key setup ────────────────────────────────────────────────────

step "4" "SSH key setup (optional)"

SSH_KEY_FOUND=""
if [ -f "${HOME}/.ssh/id_ed25519" ]; then
    SSH_KEY_FOUND="${HOME}/.ssh/id_ed25519"
    success "SSH key found: ~/.ssh/id_ed25519"
elif [ -f "${HOME}/.ssh/id_rsa" ]; then
    SSH_KEY_FOUND="${HOME}/.ssh/id_rsa"
    success "SSH key found: ~/.ssh/id_rsa"
else
    warn "No SSH key found"
    printf "\n  Generate an SSH key for gateway access? [Y/n]: "
    read -r gen_key
    if [[ ! "$gen_key" =~ ^[Nn]$ ]]; then
        info "Generating ed25519 SSH key..."
        ssh-keygen -t ed25519 -f "${HOME}/.ssh/id_ed25519" -N "" -C "tunnelvault-$(whoami)@$(hostname)"
        SSH_KEY_FOUND="${HOME}/.ssh/id_ed25519"
        success "SSH key generated: ~/.ssh/id_ed25519"
    else
        info "Skipping SSH key generation"
    fi
fi

if [ -n "$SSH_KEY_FOUND" ]; then
    printf "\n  ${CYAN}Your public key (register this with the server):${RESET}\n\n"
    printf "  ${DIM}"
    cat "${SSH_KEY_FOUND}.pub"
    printf "${RESET}\n"
fi

# ─── Step 5: Connection test ──────────────────────────────────────────────────

step "5" "Connection test"

# Derive HTTP URL from the server URL
HTTP_SERVER=$(echo "$ARG_SERVER" | sed 's|^ws://|http://|; s|^wss://|https://|')

if [ -n "$ARG_SERVER" ] && [ "$ARG_SERVER" != "ws://localhost:4000" ]; then
    info "Testing connectivity to ${HTTP_SERVER}..."

    AUTH_HEADER=""
    if [ -n "$ARG_TOKEN" ]; then
        AUTH_HEADER="-H \"Authorization: Bearer ${ARG_TOKEN}\""
    fi

    # Health check
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
        ${ARG_TOKEN:+-H "Authorization: Bearer ${ARG_TOKEN}"} \
        "${HTTP_SERVER}/api/health" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
        success "Server is reachable (HTTP ${HTTP_CODE})"

        # Fetch stats
        STATS=$(curl -s --connect-timeout 5 \
            ${ARG_TOKEN:+-H "Authorization: Bearer ${ARG_TOKEN}"} \
            "${HTTP_SERVER}/api/stats" 2>/dev/null || echo "")

        if [ -n "$STATS" ] && command -v node &>/dev/null; then
            printf "\n"
            node -e "
                try {
                    const s = JSON.parse(process.argv[1]);
                    console.log('  ${DIM}Uptime:${RESET}      ' + (s.uptime || 'N/A'));
                    console.log('  ${DIM}Tunnels:${RESET}     ' + (s.activeTunnels ?? 'N/A'));
                    console.log('  ${DIM}Connections:${RESET} ' + (s.totalConnections ?? 'N/A'));
                } catch {}
            " "$STATS" 2>/dev/null || true
            printf "\n"
        fi
    elif [ "$HTTP_CODE" = "000" ]; then
        warn "Could not reach server at ${HTTP_SERVER} (connection refused or timeout)"
        info "The server may not be running yet. You can test later with: tunnelvault status"
    else
        warn "Server responded with HTTP ${HTTP_CODE}"
    fi
else
    info "Skipping connection test (using default localhost server)"
    info "Test later with: tunnelvault status --server <your-server-url>"
fi

# ─── Step 6: Final output ─────────────────────────────────────────────────────

step "6" "Installation complete"

# Derive the gateway host from the server URL for SSH config example
GATEWAY_HOST=$(echo "$ARG_SERVER" | sed 's|^wss\?://||; s|:.*||')

printf "\n"
box_top
box_line "${GREEN}${BOLD}TunnelVault installed successfully${RESET}"
box_mid
box_line "${DIM}Install:${RESET}  ${INSTALL_DIR}"
box_line "${DIM}Config:${RESET}   ${CONFIG_FILE}"
box_line "${DIM}Command:${RESET}  ${SYMLINK_PATH}"
box_mid
box_line "${CYAN}${BOLD}Usage${RESET}"
box_line ""
box_line "  tunnelvault connect 3000"
box_line "  ${DIM}# Expose localhost:3000 to the internet${RESET}"
box_line ""
box_line "  tunnelvault connect 8080 --name my-api"
box_line "  ${DIM}# With a custom tunnel name${RESET}"
box_line ""
box_line "  tunnelvault connect 3000 --subdomain myapp"
box_line "  ${DIM}# Request a specific subdomain${RESET}"
box_line ""
box_line "  tunnelvault list"
box_line "  ${DIM}# Show active tunnels on the server${RESET}"
box_line ""
box_line "  tunnelvault status"
box_line "  ${DIM}# Check server status${RESET}"
box_mid
box_line "${CYAN}${BOLD}SSH Gateway Access${RESET}"
box_line ""
box_line "  ${DIM}Add to ~/.ssh/config:${RESET}"
box_line ""
box_line "  Host my-tunnel"
box_line "    HostName     ${GATEWAY_HOST}"
box_line "    User         gw-<YOUR_TOKEN>"
box_line "    IdentityFile ~/.ssh/id_ed25519"
box_line ""
box_line "  ${DIM}Then:  ssh my-tunnel${RESET}"
box_mid
box_line "${CYAN}${BOLD}Uninstall${RESET}"
box_line ""
box_line "  bash install-client.sh --uninstall"
box_bottom
printf "\n"
