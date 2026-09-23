#!/bin/bash
# ============================================================
# manage-user.sh — root helper that manages the Linux users of the
# legacy SSH gateway (ForceCommand ssh_router.sh).
#
# Called by usermgr-worker.sh (requests queued by the TunnelVault API)
# and by register_token.sh. Must be owned by root, mode 0755.
#
# Usage:
#   manage-user.sh create <gw-username> <ssh-public-key>
#   manage-user.sh delete <gw-username>
#
# Security:
#   - usernames must be "gw-" + 1-29 letters/digits (Linux limit: 32 chars)
#   - the public key must be a single line of a known key type; it is
#     written with the "restrict" option into a root-owned authorized_keys
#   - gateway users get /opt/tunnelvault/ssh_router.sh as login shell (sshd
#     runs ForceCommand through the login shell, so /bin/false would break
#     the gateway) and are added to the group "tunnelvault-gw", which may
#     run gateway-helper.sh as the service user (see /etc/sudoers.d/tunnelvault)
#   - delete terminates the user's live gateway sessions (revocation)
#   - full usernames embed the device token and are never printed
# ============================================================
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 022

readonly INSTALL_DIR="/opt/tunnelvault"
readonly GW_GROUP="tunnelvault-gw"
readonly GW_SHELL="${INSTALL_DIR}/ssh_router.sh"
readonly USERNAME_RE='^gw-[A-Za-z0-9]{1,29}$'
readonly PUBKEY_RE='^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+|ssh-dss|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [[:print:]]*)?$'
readonly MAX_PUBKEY_LENGTH=8192

die() { echo "ERROR: $*" >&2; exit 1; }

# "gw-abcd***" — never print the full token embedded in the username
hint() {
    local s="$1"
    if (( ${#s} > 7 )); then printf '%s***' "${s:0:7}"; else printf '%s' "$s"; fi
}

# Same rules as backend/src/userManager.js normalizePublicKey (without trimming)
valid_pubkey() {
    local pk="$1"
    (( ${#pk} > 0 && ${#pk} <= MAX_PUBKEY_LENGTH )) || return 1
    case "$pk" in
        *'`'* | *'$'* | *\\* | *'"'* | *"'"*) return 1 ;;
    esac
    [[ "$pk" =~ $PUBKEY_RE ]]
}

ACTION="${1:-}"
USERNAME="${2:-}"

[[ -n "$USERNAME" ]] || die "Username is required. Usage: manage-user.sh create|delete <gw-username> [pubkey]"
[[ "$USERNAME" =~ $USERNAME_RE ]] \
    || die "Invalid username: must be gw- followed by 1-29 letters/digits (Linux usernames are limited to 32 characters)"
USER_HINT="$(hint "$USERNAME")"

case "$ACTION" in
    create)
        [[ $# -eq 3 ]] || die "Usage: manage-user.sh create <gw-username> <ssh-public-key>"
        PUBKEY="$3"
        valid_pubkey "$PUBKEY" \
            || die "Invalid SSH public key: must be a single line 'TYPE BASE64 [comment]' (ssh-ed25519, ssh-rsa, ecdsa-sha2-*, sk-*)"
        ;;
    delete)
        [[ $# -eq 2 ]] || die "Usage: manage-user.sh delete <gw-username>"
        ;;
    *)
        die "Unknown action '${ACTION}'. Use 'create' or 'delete'."
        ;;
esac

[[ $EUID -eq 0 ]] || die "manage-user.sh must run as root"

user_exists() { getent passwd "$1" >/dev/null 2>&1; }

# Stop every process of the user: TERM first so ssh_router.sh can close its
# session record, then KILL whatever is left.
terminate_sessions() {
    local user="$1" _
    pkill -TERM -u "$user" >/dev/null 2>&1 || return 0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -u "$user" >/dev/null 2>&1 || return 0
        sleep 0.2
    done
    pkill -KILL -u "$user" >/dev/null 2>&1 || true
    sleep 0.2
}

case "$ACTION" in
    create)
        [[ -x "$GW_SHELL" ]] || die "Gateway router ${GW_SHELL} is not installed — run install-server.sh first"

        if ! getent group "$GW_GROUP" >/dev/null 2>&1; then
            groupadd --system "$GW_GROUP"
        fi

        if user_exists "$USERNAME"; then
            [[ "$(id -u "$USERNAME")" != "0" ]] || die "Refusing to modify a UID 0 account"
            usermod --shell "$GW_SHELL" --append --groups "$GW_GROUP" "$USERNAME"
            echo "User '${USER_HINT}' updated."
        else
            useradd --system --create-home --shell "$GW_SHELL" --groups "$GW_GROUP" "$USERNAME"
            echo "User '${USER_HINT}' created."
        fi

        HOME_DIR="$(getent passwd "$USERNAME" | cut -d: -f6)"
        [[ "$HOME_DIR" == /* && "$HOME_DIR" != "/" && -d "$HOME_DIR" && ! -L "$HOME_DIR" ]] \
            || die "Home directory of '${USER_HINT}' is missing or unsafe"
        # sshd StrictModes: the home directory must not be group/world writable
        chmod go-w -- "$HOME_DIR"

        # ~/.ssh and authorized_keys are root-owned: the gateway user can never
        # change its own key (sshd accepts root-owned key files).
        SSH_DIR="${HOME_DIR}/.ssh"
        if [[ -L "$SSH_DIR" || ( -e "$SSH_DIR" && ! -d "$SSH_DIR" ) ]]; then
            rm -f -- "$SSH_DIR"
        fi
        mkdir -p -- "$SSH_DIR"
        chown root:root -- "$SSH_DIR"
        chmod 0755 -- "$SSH_DIR"

        TMP_KEYS="$(mktemp "${SSH_DIR}/.authorized_keys.XXXXXX")"
        trap 'rm -f -- "$TMP_KEYS"' EXIT
        printf 'restrict %s\n' "$PUBKEY" > "$TMP_KEYS"
        chmod 0644 -- "$TMP_KEYS"
        mv -f -- "$TMP_KEYS" "${SSH_DIR}/authorized_keys"
        trap - EXIT
        echo "SSH key configured for '${USER_HINT}'."
        ;;

    delete)
        if ! user_exists "$USERNAME"; then
            echo "User '${USER_HINT}' does not exist — nothing to delete."
            exit 0
        fi
        [[ "$(id -u "$USERNAME")" != "0" ]] || die "Refusing to delete a UID 0 account"
        terminate_sessions "$USERNAME"
        if ! userdel --remove "$USERNAME" >/dev/null 2>&1; then
            userdel --force --remove "$USERNAME" >/dev/null 2>&1 || userdel "$USERNAME" >/dev/null 2>&1 || true
        fi
        if user_exists "$USERNAME"; then
            die "Could not delete user '${USER_HINT}'"
        fi
        echo "User '${USER_HINT}' deleted."
        ;;
esac
