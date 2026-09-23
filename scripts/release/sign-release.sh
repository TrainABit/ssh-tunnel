#!/usr/bin/env bash
# ================================================================
# TunnelVault — sign a built release directory.
#
# Usage:
#   scripts/release/sign-release.sh DIR [--key FILE] [--pubkey FILE | --no-pinned-pubkey]
#
#   DIR       directory containing SHA256SUMS (from build-release.sh)
#   --key     private key PEM file. Default: $RELEASE_SIGNING_KEY_FILE, else the
#             PEM text in $RELEASE_SIGNING_KEY (as passed from the GitHub secret;
#             it is written to a private temp file that is removed on exit).
#   --pubkey  pinned public key the signature must verify against
#             (default: release-signing.pub at the repository root, required
#             unless --no-pinned-pubkey is given)
#
# Writes DIR/SHA256SUMS.sig = openssl dgst -sha256 -sign KEY SHA256SUMS and then
# verifies it with the public key derived from KEY *and* with the pinned key, so a
# release signed with a key the installations do not trust is never produced.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/release-lib.sh
source "${SCRIPT_DIR}/release-lib.sh"

die() { echo "sign-release: $*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

DIR=""
KEY_FILE="${RELEASE_SIGNING_KEY_FILE:-}"
PINNED=""
USE_PINNED=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)    [[ $# -ge 2 ]] || die "--key needs a file"; KEY_FILE=$2; shift 2 ;;
    --pubkey) [[ $# -ge 2 ]] || die "--pubkey needs a file"; PINNED=$2; shift 2 ;;
    --no-pinned-pubkey) USE_PINNED=false; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) [[ -z $DIR ]] || die "only one DIR may be given"; DIR=$1; shift ;;
  esac
done
[[ -n $DIR ]] || { usage >&2; exit 2; }
[[ -f "${DIR}/SHA256SUMS" ]] || die "${DIR}/SHA256SUMS not found"

umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tv-sign.XXXXXXXX")
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT

if [[ -z $KEY_FILE ]]; then
  [[ -n ${RELEASE_SIGNING_KEY:-} ]] || die "no signing key: pass --key FILE or set RELEASE_SIGNING_KEY(_FILE)"
  KEY_FILE="${WORK}/signing.key"
  printf '%s\n' "$RELEASE_SIGNING_KEY" > "$KEY_FILE"
fi
[[ -f $KEY_FILE ]] || die "signing key file not found: $KEY_FILE"

# The key must be an ECDSA P-256 private key (never print it).
key_text=$(openssl pkey -in "$KEY_FILE" -noout -text 2>/dev/null) || die "signing key is not a readable (unencrypted) PEM private key"
[[ $key_text == *prime256v1* || $key_text == *P-256* ]] || die "signing key is not ECDSA P-256"
unset key_text

openssl pkey -in "$KEY_FILE" -pubout -out "${WORK}/derived.pub" 2>/dev/null || die "cannot derive public key"

if $USE_PINNED; then
  if [[ -z $PINNED ]]; then
    PINNED="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "${SCRIPT_DIR}/../..")/release-signing.pub"
  fi
  [[ -f $PINNED ]] || die "pinned public key $PINNED not found (commit release-signing.pub, or pass --pubkey / --no-pinned-pubkey)"
  tv_check_pubkey "$PINNED" || die "pinned public key is invalid"
  derived_fp=$(tv_pubkey_der_sha256 "${WORK}/derived.pub") || die "cannot fingerprint derived key"
  pinned_fp=$(tv_pubkey_der_sha256 "$PINNED") || die "cannot fingerprint pinned key"
  [[ $derived_fp == "$pinned_fp" ]] \
    || die "signing key does not match the pinned public key ${PINNED} (sha256:${pinned_fp}); installations would reject this release"
fi

openssl dgst -sha256 -sign "$KEY_FILE" -out "${WORK}/SHA256SUMS.sig" "${DIR}/SHA256SUMS" 2>/dev/null || die "openssl signing failed"

verified=$(openssl dgst -sha256 -verify "${WORK}/derived.pub" -signature "${WORK}/SHA256SUMS.sig" "${DIR}/SHA256SUMS" 2>/dev/null || true)
[[ $verified == "Verified OK" ]] || die "signature self-check failed"
if $USE_PINNED; then
  verified=$(openssl dgst -sha256 -verify "$PINNED" -signature "${WORK}/SHA256SUMS.sig" "${DIR}/SHA256SUMS" 2>/dev/null || true)
  [[ $verified == "Verified OK" ]] || die "signature does not verify with the pinned public key"
fi

install -m 0644 "${WORK}/SHA256SUMS.sig" "${DIR}/SHA256SUMS.sig"
echo "Signed ${DIR}/SHA256SUMS -> ${DIR}/SHA256SUMS.sig (key sha256:$(tv_pubkey_der_sha256 "${WORK}/derived.pub"))"
