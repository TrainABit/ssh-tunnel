# shellcheck shell=bash
# ================================================================
# TunnelVault release tooling — shared shell library (sourced, not executed).
#
# The block between the '>>> tv-verify' and '<<< tv-verify' markers is the
# signed-release verification used everywhere. An IDENTICAL copy is inlined in
# auto-update.sh and auto-update-client.sh (the updaters are installed as
# standalone files); scripts/release/test/release.test.js fails if the copies
# drift apart.
# ================================================================

# >>> tv-verify (keep identical in scripts/release/release-lib.sh, auto-update.sh, auto-update-client.sh)
# Release layout: tunnelvault-vX.Y.Z.tar.gz + SHA256SUMS + SHA256SUMS.sig, where
# SHA256SUMS.sig = `openssl dgst -sha256 -sign <ECDSA P-256 key> SHA256SUMS`.
# Order matters: the signature over SHA256SUMS is checked FIRST against the
# pinned public key; only then is the tarball's line in SHA256SUMS trusted.
tv_verify_fail() {
  printf 'verify: %s\n' "$*" >&2
  return 1
}

# tv_sha256 FILE -> prints the lowercase hex SHA-256 of FILE.
tv_sha256() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out=$(sha256sum < "$1") || return 1
  else
    out=$(openssl dgst -sha256 -r < "$1") || return 1
  fi
  out=${out%% *}
  [[ $out =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$out"
}

# tv_check_pubkey FILE -> succeeds if FILE is a PEM ECDSA P-256 public key.
tv_check_pubkey() {
  local text
  if [[ ! -f $1 || ! -r $1 ]]; then
    tv_verify_fail "release public key not found: $1"
    return 1
  fi
  if ! text=$(openssl pkey -pubin -in "$1" -noout -text 2>/dev/null); then
    tv_verify_fail "not a PEM public key: $1"
    return 1
  fi
  if [[ $text != *prime256v1* && $text != *P-256* ]]; then
    tv_verify_fail "release public key is not ECDSA P-256: $1"
    return 1
  fi
}

# tv_verify_release PUBKEY SHA256SUMS SHA256SUMS.sig TARBALL
tv_verify_release() {
  local pubkey=$1 sums=$2 sig=$3 tarball=$4
  local f name line expected="" count=0 actual verified
  local re='^([0-9a-fA-F]{64}) [ *](.+)$'
  for f in "$sums" "$sig" "$tarball"; do
    if [[ ! -f $f ]]; then
      tv_verify_fail "missing file: $f"
      return 1
    fi
  done
  tv_check_pubkey "$pubkey" || return 1
  if [[ ! -s $sums ]] || (( $(wc -c < "$sums") > 65536 )); then
    tv_verify_fail "SHA256SUMS is empty or too large"
    return 1
  fi
  # 1) Signature over SHA256SUMS with the pinned public key.
  if ! verified=$(openssl dgst -sha256 -verify "$pubkey" -signature "$sig" "$sums" 2>/dev/null) \
      || [[ $verified != "Verified OK" ]]; then
    tv_verify_fail "SIGNATURE VERIFICATION FAILED for ${sums##*/} (wrong key or tampered file)"
    return 1
  fi
  # 2) Checksum of the tarball — only its own line of the (now trusted) SHA256SUMS.
  name=${tarball##*/}
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line =~ $re ]] && [[ ${BASH_REMATCH[2]} == "$name" ]]; then
      expected=${BASH_REMATCH[1],,}
      count=$((count + 1))
    fi
  done < "$sums"
  if (( count != 1 )); then
    tv_verify_fail "expected exactly one SHA256SUMS entry for $name, found $count"
    return 1
  fi
  if ! actual=$(tv_sha256 "$tarball"); then
    tv_verify_fail "cannot hash $tarball"
    return 1
  fi
  if [[ $actual != "$expected" ]]; then
    tv_verify_fail "CHECKSUM MISMATCH for $name"
    return 1
  fi
  return 0
}
# <<< tv-verify

# ── Helpers for the release scripts (not used by the updaters) ────────────

# tv_normalize_version "v1.2.3" | "1.2.3" -> prints "1.2.3" or fails.
tv_normalize_version() {
  local v=${1#v}
  [[ $v =~ ^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$ ]] || return 1
  printf '%s\n' "$v"
}

# tv_pubkey_der_sha256 PUBKEY_PEM -> SHA-256 of the DER SubjectPublicKeyInfo (key fingerprint).
tv_pubkey_der_sha256() {
  local out
  out=$(openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 -r) || return 1
  out=${out%% *}
  [[ $out =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$out"
}
