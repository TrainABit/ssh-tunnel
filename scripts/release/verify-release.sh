#!/usr/bin/env bash
# ================================================================
# TunnelVault — verify a signed release before installing it.
#
# Usage:
#   scripts/release/verify-release.sh [--pubkey FILE] [--sums FILE] [--sig FILE] TARBALL
#
#   TARBALL        tunnelvault-vX.Y.Z.tar.gz
#   --pubkey FILE  pinned release public key (default: the installed
#                  /etc/tunnelvault/release-signing.pub, else release-signing.pub
#                  at the root of the tree this script belongs to)
#   --sums FILE    checksum list (default: SHA256SUMS next to TARBALL)
#   --sig FILE     signature     (default: SHA256SUMS.sig next to TARBALL)
#
# Checks, in this order (fails closed on anything unexpected):
#   1. SHA256SUMS.sig is a valid ECDSA P-256 / SHA-256 signature of SHA256SUMS
#      made by the pinned key   (openssl dgst -sha256 -verify)
#   2. the SHA-256 of TARBALL equals ITS line in SHA256SUMS
#
# Run it from a trusted copy (an existing checkout or installation) — never
# trust a script or key that came inside the archive being verified.
# Exit status 0 = verified, 1 = verification failed, 2 = usage error.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/release-lib.sh
source "${SCRIPT_DIR}/release-lib.sh"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

PUBKEY=""
SUMS=""
SIG=""
TARBALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pubkey) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; PUBKEY=$2; shift 2 ;;
    --sums)   [[ $# -ge 2 ]] || { usage >&2; exit 2; }; SUMS=$2; shift 2 ;;
    --sig)    [[ $# -ge 2 ]] || { usage >&2; exit 2; }; SIG=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      [[ -z $TARBALL ]] || { echo "Only one TARBALL may be given" >&2; exit 2; }
      TARBALL=$1; shift ;;
  esac
done
[[ -n $TARBALL ]] || { usage >&2; exit 2; }

if [[ -z $PUBKEY ]]; then
  if [[ -f /etc/tunnelvault/release-signing.pub ]]; then
    PUBKEY=/etc/tunnelvault/release-signing.pub
  else
    PUBKEY="${SCRIPT_DIR}/../../release-signing.pub"
    echo "note: using ${PUBKEY} — make sure this source tree is trusted" >&2
  fi
fi
TARBALL_DIR=$(dirname -- "$TARBALL")
SUMS=${SUMS:-${TARBALL_DIR}/SHA256SUMS}
SIG=${SIG:-${TARBALL_DIR}/SHA256SUMS.sig}

if tv_verify_release "$PUBKEY" "$SUMS" "$SIG" "$TARBALL"; then
  fp=$(tv_pubkey_der_sha256 "$PUBKEY" || echo "?")
  echo "OK: ${TARBALL##*/} — signature (key sha256:${fp}) and checksum verified"
  exit 0
fi
echo "FAILED: do NOT install ${TARBALL##*/}" >&2
exit 1
