#!/bin/bash
# ============================================================
# manage-user.sh — Root-level helper for managing gateway Linux users
# Called by the TunnelVault API via sudo.
#
# Usage:
#   manage-user.sh create <username> <pubkey>
#   manage-user.sh delete <username>
#
# Security: username MUST start with "gw-" and be alphanumeric.
# This script must be owned by root and chmod 755.
# ============================================================
set -euo pipefail

ACTION="${1:-}"
USERNAME="${2:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Validate username ────────────────────────────────────────
[[ -z "$USERNAME" ]] && die "Username is required"

# Security: only allow usernames starting with "gw-" followed by alphanumerics
if [[ ! "$USERNAME" =~ ^gw-[a-zA-Z0-9]+$ ]]; then
    die "Invalid username format: must match gw-[a-zA-Z0-9]+"
fi

case "$ACTION" in
    create)
        PUBKEY="${3:-}"
        [[ -z "$PUBKEY" ]] && die "Public key is required for create"

        # Validate SSH public key format (must start with a known key type)
        # This prevents injection of arbitrary content into authorized_keys
        if [[ ! "$PUBKEY" =~ ^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp[0-9]+|ssh-dss)[[:space:]] ]]; then
            die "Invalid SSH public key format: must start with a valid key type (ssh-rsa, ssh-ed25519, etc.)"
        fi

        # Reject keys containing newlines or shell metacharacters
        if [[ "$PUBKEY" == *$'\n'* ]] || [[ "$PUBKEY" == *$'\r'* ]] || [[ "$PUBKEY" == *'`'* ]] || [[ "$PUBKEY" == *'$('* ]]; then
            die "Public key contains invalid characters"
        fi

        # Create system user if it doesn't exist
        if ! id "$USERNAME" &>/dev/null; then
            useradd -r -s /bin/false -m "$USERNAME"
            echo "User '$USERNAME' created."
        else
            echo "User '$USERNAME' already exists."
        fi

        # Set up ~/.ssh/authorized_keys
        SSH_DIR="/home/$USERNAME/.ssh"
        mkdir -p "$SSH_DIR"
        echo "$PUBKEY" > "$SSH_DIR/authorized_keys"
        chown -R "$USERNAME":"$USERNAME" "$SSH_DIR"
        chmod 700 "$SSH_DIR"
        chmod 600 "$SSH_DIR/authorized_keys"
        echo "SSH authorized_keys configured for '$USERNAME'."
        ;;

    delete)
        if id "$USERNAME" &>/dev/null; then
            userdel -r "$USERNAME" 2>/dev/null || true
            echo "User '$USERNAME' deleted."
        else
            echo "User '$USERNAME' does not exist — nothing to delete."
        fi
        ;;

    *)
        die "Unknown action: '$ACTION'. Use 'create' or 'delete'."
        ;;
esac
