#!/usr/bin/env bash
# ================================================================
# TunnelVault — generate the release signing key pair (maintainers only).
#
# Usage:
#   scripts/release/generate-signing-key.sh [--out DIR]
#
# Creates an ECDSA P-256 key pair with openssl:
#   DIR/release-signing.key   private key (PEM, mode 0600)  -> GitHub secret RELEASE_SIGNING_KEY
#   DIR/release-signing.pub   public key  (PEM, mode 0644)  -> commit as ./release-signing.pub
#
# DIR defaults to a fresh private temp directory and must NOT be inside a git
# work tree (so the private key cannot be committed by accident). Existing
# files are never overwritten.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/release-lib.sh
source "${SCRIPT_DIR}/release-lib.sh"

die() { echo "error: $*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) [[ $# -ge 2 ]] || die "--out needs a directory"; OUT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

command -v openssl >/dev/null 2>&1 || die "openssl is required"
umask 077

if [[ -z $OUT ]]; then
  OUT=$(mktemp -d "${TMPDIR:-/tmp}/tunnelvault-signing.XXXXXXXX")
else
  parent=$(dirname -- "$OUT")
  [[ -d $parent ]] || die "parent directory of $OUT does not exist"
  if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "$OUT is inside a git work tree — choose a directory outside any repository for the private key"
  fi
  mkdir -p -- "$OUT"
fi
OUT=$(cd -- "$OUT" && pwd)
if git -C "$OUT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "$OUT is inside a git work tree — choose a directory outside any repository for the private key"
fi

KEY="${OUT}/release-signing.key"
PUB="${OUT}/release-signing.pub"
[[ ! -e $KEY && ! -e $PUB ]] || die "refusing to overwrite an existing key in $OUT"

openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -pkeyopt ec_param_enc:named_curve \
  -out "$KEY" 2>/dev/null || die "openssl genpkey failed"
chmod 600 "$KEY"
openssl pkey -in "$KEY" -pubout -out "$PUB" 2>/dev/null || die "could not derive the public key"
chmod 644 "$PUB"

# Self-test: sign + verify a probe with the new pair.
probe="${OUT}/.probe"
printf 'tunnelvault-signing-probe\n' > "$probe"
openssl dgst -sha256 -sign "$KEY" -out "${probe}.sig" "$probe" 2>/dev/null || die "signing self-test failed"
probe_result=$(openssl dgst -sha256 -verify "$PUB" -signature "${probe}.sig" "$probe" 2>/dev/null || true)
rm -f -- "$probe" "${probe}.sig"
[[ $probe_result == "Verified OK" ]] || die "verification self-test failed"
tv_check_pubkey "$PUB" || die "generated public key is not ECDSA P-256"

FP=$(tv_pubkey_der_sha256 "$PUB")

cat <<EOF

TunnelVault release signing key pair created (ECDSA P-256):

  private key : ${KEY}   (mode 0600 — keep secret)
  public key  : ${PUB}
  fingerprint : sha256:${FP}   (SHA-256 of the DER public key)

Next steps:

  1. Store the PRIVATE key as the GitHub Actions secret RELEASE_SIGNING_KEY
     (the release workflow signs in the 'release' environment):
       gh secret set RELEASE_SIGNING_KEY --repo TrainABit/ssh-tunnel < "${KEY}"
     or: GitHub -> Settings -> Secrets and variables -> Actions -> New secret,
     paste the full PEM including the BEGIN/END lines.
     Recommended: Settings -> Environments -> 'release' -> required reviewers
     and a tag rule (v*.*.*), and store the secret there.

  2. Commit the PUBLIC key at the repository root:
       cp "${PUB}" <repo>/release-signing.pub
       git add release-signing.pub && git commit -m "Add release signing public key"

  3. Keep an offline backup of the private key (password manager / hardware
     token), then delete the local copy:
       shred -u "${KEY}"

  4. Publish the fingerprint above through a second channel (website, docs) so
     operators can check the release-signing.pub they install:
       openssl pkey -pubin -in release-signing.pub -outform DER | sha256sum

  Rotating the key later means shipping the new release-signing.pub to every
  installation (installer --release-pubkey FILE, or /etc/tunnelvault/release-signing.pub).
EOF
