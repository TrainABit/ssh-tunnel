#!/bin/bash
# ================================================================
# TunnelVault Client Auto-Updater (signed GitHub releases, no git)
#
# Installed by `install-client.sh --auto-update --release-pubkey FILE` as
# /opt/tunnelvault-client/auto-update-client.sh and run as root by
# tunnelvault-client-autoupdate.timer. Manual run:
#   sudo /opt/tunnelvault-client/auto-update-client.sh [--dry-run]
#
# Settings: /etc/tunnelvault/update.conf
#   ENABLED=1                 0 disables updates
#   SCHEDULE=12h              timer interval (used by the installer)
#   UPDATE_REPO=TrainABit/ssh-tunnel
#   PINNED_VERSION=           empty = latest GitHub release, else X.Y.Z
#   PUBKEY=/etc/tunnelvault/release-signing.pub
#
# Each run: resolve the target release -> skip if already installed, never
# downgrade -> download over HTTPS -> verify SHA256SUMS.sig with the pinned
# public key, THEN the tarball checksum -> extract into a private staging dir
# (no links/absolute/.. paths) -> check VERSION == tag -> run
# `install-client.sh --upgrade` from the verified tree. Any failure aborts
# without touching the installation (fail closed).
#
# Test/mirror overrides (environment only): UPDATE_BASE_URL (release download
# base; <base>/<tag>/<asset>), UPDATE_API_URL (latest-release JSON). Both must
# be https:// (plain http only for loopback). Signature verification cannot be
# disabled. TUNNELVAULT_UPDATE_CONF, TUNNELVAULT_INSTALL_DIR,
# TUNNELVAULT_UPDATE_LOG (empty = journal only) and TUNNELVAULT_UPDATE_LOCK
# relocate the files used.
# ================================================================
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

# ── Role-specific settings ──────────────────────────────────────────
TV_ROLE="client"
TV_INSTALL_DIR="${TUNNELVAULT_INSTALL_DIR:-/opt/tunnelvault-client}"
TV_INSTALLER="install-client.sh"
TV_INSTALLER_ARGS=(--upgrade)
TV_LOG_FILE="${TUNNELVAULT_UPDATE_LOG-/var/log/tunnelvault-client-update.log}"
TV_LOCK_FILE="${TUNNELVAULT_UPDATE_LOCK:-/run/tunnelvault-client-update.lock}"

# >>> tv-updater-common (keep identical in auto-update.sh and auto-update-client.sh)
TV_CONF="${TUNNELVAULT_UPDATE_CONF:-/etc/tunnelvault/update.conf}"
TV_DEFAULT_REPO="TrainABit/ssh-tunnel"
TV_DEFAULT_PUBKEY="/etc/tunnelvault/release-signing.pub"
TV_MAX_TARBALL_BYTES=$((256 * 1024 * 1024))
TV_MAX_LOG_LINES=2000
TV_WORK=""
TV_DRY_RUN=false
TV_INSTALL_STARTED=false

log() {
  local msg
  msg="[$(date '+%Y-%m-%d %H:%M:%S')] [${TV_ROLE}-update] $*"
  printf '%s\n' "$msg" >&2
  if [[ -n $TV_LOG_FILE && ! -L $TV_LOG_FILE ]]; then
    printf '%s\n' "$msg" >> "$TV_LOG_FILE" 2>/dev/null || true
  fi
}

die() {
  log "ERROR: $*"
  if $TV_INSTALL_STARTED; then
    log "Update aborted while the installer was running — see its output above."
  else
    log "Update aborted — the installed version was not changed."
  fi
  exit 1
}

# shellcheck disable=SC2317,SC2329  # invoked via trap (SC2317: shellcheck < 0.10)
on_err() {
  (( BASH_SUBSHELL == 0 )) || return 0
  log "ERROR: unexpected failure (line $1, exit $2)"
}

# shellcheck disable=SC2317,SC2329  # invoked via trap (SC2317: shellcheck < 0.10)
cleanup() {
  if [[ -n $TV_WORK && -d $TV_WORK ]]; then
    rm -rf -- "$TV_WORK"
  fi
}

rotate_log() {
  [[ -n $TV_LOG_FILE && -f $TV_LOG_FILE && ! -L $TV_LOG_FILE ]] || return 0
  local lines
  lines=$(wc -l < "$TV_LOG_FILE" 2>/dev/null || echo 0)
  if (( lines > TV_MAX_LOG_LINES )); then
    if tail -n $((TV_MAX_LOG_LINES / 2)) "$TV_LOG_FILE" > "${TV_LOG_FILE}.tmp" 2>/dev/null; then
      mv -f -- "${TV_LOG_FILE}.tmp" "$TV_LOG_FILE" || true
    fi
    rm -f -- "${TV_LOG_FILE}.tmp"
  fi
}

# Files that steer what root installs must not be writable by anyone else.
check_trusted_file() {
  local file=$1 what=$2 owner mode dir
  [[ -f $file ]] || die "$what not found: $file"
  owner=$(stat -L -c '%u' -- "$file") || die "cannot stat $file"
  mode=$(stat -L -c '%a' -- "$file") || die "cannot stat $file"
  if [[ $owner != 0 && $owner != "$EUID" ]]; then
    die "$what $file must be owned by root"
  fi
  if (( (8#$mode & 8#022) != 0 )); then
    die "$what $file is writable by group/others (mode $mode) — refusing to use it"
  fi
  dir=$(dirname -- "$file")
  owner=$(stat -L -c '%u' -- "$dir") || die "cannot stat $dir"
  mode=$(stat -L -c '%a' -- "$dir") || die "cannot stat $dir"
  if [[ $owner != 0 && $owner != "$EUID" ]] || (( (8#$mode & 8#022) != 0 )); then
    die "directory $dir (holding $what) must be owned by root and not group/world-writable"
  fi
}

trim() {
  local s=$1
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Parse update.conf as KEY=VALUE lines (never sourced / executed).
CONF_ENABLED=""
CONF_REPO=""
CONF_PINNED=""
CONF_PUBKEY=""
read_conf() {
  local line key value n=0
  check_trusted_file "$TV_CONF" "update config"
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ ! $line =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=(.*)$ ]]; then
      die "$TV_CONF line $n is not KEY=VALUE"
    fi
    key=${BASH_REMATCH[1]}
    value=$(trim "${BASH_REMATCH[2]}")
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then
      value=${BASH_REMATCH[1]}
    fi
    case "$key" in
      ENABLED)        CONF_ENABLED=$value ;;
      UPDATE_REPO)    CONF_REPO=$value ;;
      PINNED_VERSION) CONF_PINNED=$value ;;
      PUBKEY)         CONF_PUBKEY=$value ;;
      SCHEDULE)       : ;;  # used by the installer for the timer
      *) log "warning: ignoring unknown setting $key in $TV_CONF" ;;
    esac
  done < "$TV_CONF"

  case "${CONF_ENABLED,,}" in
    1|true|yes|on) CONF_ENABLED=1 ;;
    ""|0|false|no|off) CONF_ENABLED=0 ;;
    *) die "ENABLED must be 1 or 0 in $TV_CONF" ;;
  esac
  CONF_REPO=${CONF_REPO:-$TV_DEFAULT_REPO}
  if [[ ! $CONF_REPO =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] || [[ $CONF_REPO == *..* ]]; then
    die "UPDATE_REPO must look like owner/repo"
  fi
  if [[ -n $CONF_PINNED ]]; then
    [[ $CONF_PINNED =~ ^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || die "PINNED_VERSION must be X.Y.Z (or empty for the latest release)"
    CONF_PINNED="v${CONF_PINNED#v}"
  fi
  CONF_PUBKEY=${CONF_PUBKEY:-$TV_DEFAULT_PUBKEY}
  [[ $CONF_PUBKEY =~ ^/[A-Za-z0-9._/-]+$ && $CONF_PUBKEY != *..* ]] || die "PUBKEY must be an absolute path"
}

# Only https:// URLs; plain http:// is accepted for loopback test servers only.
check_url() {
  local url=$1 path='(/[A-Za-z0-9._~%+/-]*)?'
  local host='([A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]+\])'
  local https_re="^https://${host}(:[0-9]{1,5})?${path}\$"
  local loop_re="^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]{1,5})?${path}\$"
  [[ $url =~ $https_re || $url =~ $loop_re ]]
}

fetch() {
  local url=$1 out=$2 max=$3 accept=${4:-*/*} proto='=https' size
  check_url "$url" || die "refusing non-HTTPS URL: $url"
  [[ $url == http://* ]] && proto='=http,https'
  if ! curl --proto "$proto" --proto-redir '=https' --tlsv1.2 -fsSL \
      --connect-timeout 20 --max-time 1800 --retry 3 --retry-delay 5 \
      --max-filesize "$max" -A "tunnelvault-updater/${TV_ROLE}" \
      -H "Accept: ${accept}" -o "$out" "$url"; then
    return 1
  fi
  size=$(stat -c '%s' -- "$out")
  (( size <= max )) || { log "download $url exceeds $max bytes"; return 1; }
}

# Prints -1, 0 or 1 comparing two X.Y.Z versions.
version_cmp() {
  if [[ $1 == "$2" ]]; then
    echo 0
  elif [[ $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1) == "$1" ]]; then
    echo -1
  else
    echo 1
  fi
}

resolve_target() {
  local api json tag
  if [[ -n $CONF_PINNED ]]; then
    TARGET_TAG=$CONF_PINNED
    log "Pinned release: $TARGET_TAG"
    return 0
  fi
  api=${UPDATE_API_URL:-https://api.github.com/repos/${CONF_REPO}/releases/latest}
  json="${TV_WORK}/latest.json"
  fetch "$api" "$json" 1048576 'application/vnd.github+json' || die "could not query the latest release ($api)"
  command -v node >/dev/null 2>&1 || die "node is required to parse the release metadata"
  tag=$(TV_JSON_FILE="$json" node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.env.TV_JSON_FILE, "utf8")); } catch { process.exit(2); }
    const t = d && typeof d.tag_name === "string" ? d.tag_name : "";
    if (d.draft === true || d.prerelease === true || !/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(t)) process.exit(3);
    process.stdout.write(t);
  ') || die "latest release metadata has no valid tag_name (expected vX.Y.Z)"
  TARGET_TAG=$tag
  log "Latest release: $TARGET_TAG"
}

installed_version() {
  local v=""
  if [[ -f "${TV_INSTALL_DIR}/VERSION" ]]; then
    v=$(head -c 64 -- "${TV_INSTALL_DIR}/VERSION" | tr -d '[:space:]')
  fi
  if [[ $v =~ ^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]]; then
    printf '%s' "${v#v}"
  fi
}

# Archive must be a plain tree under PREFIX/: no absolute paths, no '..',
# only regular files and directories (no symlinks, hard links or devices).
check_archive() {
  local tarball=$1 prefix=$2 listing entry types
  local -a entries
  listing=$(tar -tzf "$tarball") || die "cannot list archive"
  [[ -n $listing ]] || die "archive is empty"
  mapfile -t entries <<< "$listing"
  for entry in "${entries[@]}"; do
    [[ $entry != /* ]] || die "archive contains an absolute path: $entry"
    [[ "/${entry}/" != */../* ]] || die "archive contains a '..' path: $entry"
    [[ $entry == "$prefix" || $entry == "$prefix/" || $entry == "$prefix/"* ]] \
      || die "archive entry outside ${prefix}/: $entry"
  done
  types=$(tar -tvzf "$tarball" | cut -c1 | sort -u | tr -d '\n') || die "cannot list archive"
  [[ $types =~ ^[-d]+$ ]] || die "archive contains links or special files (types: $types)"
}

run_installer() {
  local src=$1 status_file="${TV_WORK}/installer.status" status
  log "Running ${TV_INSTALLER} ${TV_INSTALLER_ARGS[*]} from the verified release"
  echo 1 > "$status_file"
  {
    ( cd "$src" && TUNNELVAULT_UPDATER=1 bash "./${TV_INSTALLER}" "${TV_INSTALLER_ARGS[@]}" ) < /dev/null 2>&1 \
      && echo 0 > "$status_file" \
      || echo "$?" > "$status_file"
  } | while IFS= read -r line; do log "  | $line"; done
  status=$(< "$status_file")
  [[ $status == 0 ]]
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) TV_DRY_RUN=true ;;
      -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; return 0 ;;
      *) echo "Unknown option: $arg" >&2; return 2 ;;
    esac
  done

  trap cleanup EXIT
  trap 'on_err "$LINENO" "$?"' ERR
  rotate_log

  for arg in curl openssl tar gzip flock sort stat; do
    command -v "$arg" >/dev/null 2>&1 || die "required tool not found: $arg"
  done

  exec 9>>"$TV_LOCK_FILE" || die "cannot open lock file $TV_LOCK_FILE"
  if ! flock -n 9; then
    log "Another update run holds $TV_LOCK_FILE — exiting"
    return 0
  fi

  read_conf
  if [[ $CONF_ENABLED != 1 ]]; then
    log "Automatic updates are disabled (ENABLED=0 in $TV_CONF)"
    return 0
  fi
  check_trusted_file "$CONF_PUBKEY" "release public key"
  tv_check_pubkey "$CONF_PUBKEY" || die "invalid release public key $CONF_PUBKEY"

  TV_WORK=$(mktemp -d "${TMPDIR:-/var/tmp}/tunnelvault-update.XXXXXXXX") || die "mktemp failed"
  chmod 700 -- "$TV_WORK"

  local installed cmp base tarball_name src archive_version
  resolve_target
  installed=$(installed_version)
  if [[ -z $installed ]]; then
    log "warning: installed version unknown (${TV_INSTALL_DIR}/VERSION missing) — treating as upgrade"
  else
    cmp=$(version_cmp "${TARGET_TAG#v}" "$installed")
    if [[ $cmp == 0 ]]; then
      log "Up to date (v${installed})"
      return 0
    fi
    if [[ $cmp == -1 ]]; then
      if [[ -n $CONF_PINNED ]]; then
        die "refusing to downgrade from v${installed} to pinned ${TARGET_TAG} (install older releases manually)"
      fi
      log "warning: latest release ${TARGET_TAG} is older than installed v${installed} — refusing to downgrade"
      return 0
    fi
  fi
  log "Updating ${installed:+v${installed} }-> ${TARGET_TAG}"

  base=${UPDATE_BASE_URL:-https://github.com/${CONF_REPO}/releases/download}
  base=${base%/}
  tarball_name="tunnelvault-${TARGET_TAG}.tar.gz"
  fetch "${base}/${TARGET_TAG}/${tarball_name}" "${TV_WORK}/${tarball_name}" "$TV_MAX_TARBALL_BYTES" \
    || die "download of ${tarball_name} failed"
  fetch "${base}/${TARGET_TAG}/SHA256SUMS" "${TV_WORK}/SHA256SUMS" 65536 || die "download of SHA256SUMS failed"
  fetch "${base}/${TARGET_TAG}/SHA256SUMS.sig" "${TV_WORK}/SHA256SUMS.sig" 8192 || die "download of SHA256SUMS.sig failed"

  if ! tv_verify_release "$CONF_PUBKEY" "${TV_WORK}/SHA256SUMS" "${TV_WORK}/SHA256SUMS.sig" "${TV_WORK}/${tarball_name}"; then
    die "release ${TARGET_TAG} FAILED signature/checksum verification — not installing"
  fi
  log "Signature and checksum verified for ${tarball_name}"

  check_archive "${TV_WORK}/${tarball_name}" "tunnelvault-${TARGET_TAG}"
  mkdir -m 700 -- "${TV_WORK}/src"
  tar -xzf "${TV_WORK}/${tarball_name}" -C "${TV_WORK}/src" --no-same-owner --no-same-permissions \
    || die "extraction failed"
  if [[ -n $(find "${TV_WORK}/src" \( -type l -o ! -type f ! -type d \) -print -quit) ]]; then
    die "extracted tree contains links or special files"
  fi
  src="${TV_WORK}/src/tunnelvault-${TARGET_TAG}"
  [[ -f "${src}/VERSION" ]] || die "release has no VERSION file"
  archive_version=$(head -c 64 -- "${src}/VERSION" | tr -d '[:space:]')
  [[ $archive_version == "${TARGET_TAG#v}" ]] \
    || die "VERSION in the archive (${archive_version}) does not match the tag ${TARGET_TAG}"
  [[ -f "${src}/${TV_INSTALLER}" ]] || die "release has no ${TV_INSTALLER}"

  if $TV_DRY_RUN; then
    log "Dry run: ${TARGET_TAG} downloaded, verified and extracted — installer not run"
    return 0
  fi
  TV_INSTALL_STARTED=true
  if ! run_installer "$src"; then
    die "${TV_INSTALLER} failed while installing ${TARGET_TAG}"
  fi
  log "Update to ${TARGET_TAG} complete"
}
# <<< tv-updater-common

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

main "$@"; exit $?
