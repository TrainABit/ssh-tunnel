#!/bin/bash
# ============================================================
# gateway/setup.sh — DEPRECATED.
#
# This script used to install a second, incompatible copy of TunnelVault
# (different service name, schema and permissions). The legacy SSH gateway
# is now installed and maintained by the main installer, install-server.sh,
# which this wrapper runs with the same arguments.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${SCRIPT_DIR}/../install-server.sh"

echo "NOTICE: gateway/setup.sh is deprecated — running install-server.sh instead." >&2
echo "        Use: sudo bash install-server.sh --help" >&2

if [[ ! -f "$INSTALLER" ]]; then
    echo "ERROR: ${INSTALLER} not found." >&2
    exit 1
fi
exec bash "$INSTALLER" "$@"
