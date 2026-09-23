#!/usr/bin/env bash
# ================================================================
# TunnelVault — build (and optionally sign) a release.
#
# Usage:
#   scripts/release/build-release.sh VERSION [options]
#
#   VERSION                 X.Y.Z or vX.Y.Z — must equal the VERSION file committed at HEAD
#   --out DIR               output directory (default: <repo>/dist/release)
#   --skip-frontend-build   use the already built <repo>/frontend/dist
#   --frontend-dist DIR     use a prebuilt frontend from DIR (must contain index.html)
#                           (default: npm ci + npm run build inside the exported tree)
#   --key FILE              sign with this private key (see sign-release.sh; the
#                           RELEASE_SIGNING_KEY / RELEASE_SIGNING_KEY_FILE env vars work too)
#   --pubkey FILE           pinned public key the signature must match
#                           (default: <repo>/release-signing.pub)
#   --unsigned              only build tarball + SHA256SUMS (sign later with sign-release.sh)
#   --require-tag           HEAD must carry the tag vVERSION (used by CI)
#
# Output (in --out):
#   tunnelvault-vX.Y.Z.tar.gz   git archive of HEAD + prebuilt frontend/dist + VERSION,
#                               all under the prefix tunnelvault-vX.Y.Z/ (reproducible:
#                               sorted, root-owned, mtime = HEAD commit time, gzip -n)
#   SHA256SUMS                  sha256sum of the tarball
#   SHA256SUMS.sig              openssl dgst -sha256 -sign KEY SHA256SUMS (unless --unsigned)
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/release-lib.sh
source "${SCRIPT_DIR}/release-lib.sh"

die() { echo "build-release: $*" >&2; exit 1; }
log() { echo "==> $*"; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); if ($0 !~ /^=+$/) print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

VERSION_ARG=""
OUT=""
FRONTEND_MODE="build"   # build | skip | dir
FRONTEND_DIST=""
SIGN=true
REQUIRE_TAG=false
SIGN_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)                 [[ $# -ge 2 ]] || die "--out needs a directory"; OUT=$2; shift 2 ;;
    --skip-frontend-build) FRONTEND_MODE=skip; shift ;;
    --frontend-dist)       [[ $# -ge 2 ]] || die "--frontend-dist needs a directory"; FRONTEND_MODE=dir; FRONTEND_DIST=$2; shift 2 ;;
    --key)                 [[ $# -ge 2 ]] || die "--key needs a file"; SIGN_ARGS+=(--key "$2"); shift 2 ;;
    --pubkey)              [[ $# -ge 2 ]] || die "--pubkey needs a file"; SIGN_ARGS+=(--pubkey "$2"); shift 2 ;;
    --unsigned)            SIGN=false; shift ;;
    --require-tag)         REQUIRE_TAG=true; shift ;;
    -h|--help)             usage; exit 0 ;;
    -*)                    usage >&2; die "unknown option: $1" ;;
    *) [[ -z $VERSION_ARG ]] || die "only one VERSION may be given"; VERSION_ARG=$1; shift ;;
  esac
done
[[ -n $VERSION_ARG ]] || { usage >&2; exit 2; }
VERSION=$(tv_normalize_version "$VERSION_ARG") || die "invalid version '$VERSION_ARG' (expected X.Y.Z)"
TAG="v${VERSION}"
NAME="tunnelvault-${TAG}"

for tool in git tar gzip openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
HEAD_COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}') || die "repository has no HEAD commit"

# ── Version / tag consistency ────────────────────────────────────────
HEAD_VERSION=$(git -C "$REPO_ROOT" show "HEAD:VERSION" 2>/dev/null | tr -d '[:space:]') \
  || die "VERSION file is not committed at HEAD"
[[ $HEAD_VERSION == "$VERSION" ]] \
  || die "requested $VERSION but the VERSION file at HEAD says '${HEAD_VERSION}' — bump VERSION, commit, tag v<VERSION>"
if [[ -f "${REPO_ROOT}/VERSION" ]] && [[ $(tr -d '[:space:]' < "${REPO_ROOT}/VERSION") != "$VERSION" ]]; then
  echo "warning: working-tree VERSION differs from HEAD; the release is built from HEAD" >&2
fi
if [[ ${GITHUB_REF_TYPE:-} == tag && ${GITHUB_REF_NAME:-} != "$TAG" ]]; then
  die "CI tag ${GITHUB_REF_NAME:-} does not match VERSION ($TAG)"
fi
if $REQUIRE_TAG; then
  tag_commit=$(git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2>/dev/null) \
    || die "tag $TAG does not exist"
  [[ $tag_commit == "$HEAD_COMMIT" ]] || die "tag $TAG does not point at HEAD"
fi
if [[ -n $(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null) ]]; then
  echo "warning: uncommitted changes are NOT part of the release (built from HEAD ${HEAD_COMMIT:0:12})" >&2
fi

# ── Stage: git archive of HEAD ───────────────────────────────────────
OUT=${OUT:-${REPO_ROOT}/dist/release}
mkdir -p -- "$OUT"
OUT=$(cd -- "$OUT" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tv-build.XXXXXXXX")
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT
STAGE="${WORK}/${NAME}"
mkdir -p -- "$STAGE"
log "Exporting ${HEAD_COMMIT:0:12} (HEAD) to ${NAME}/"
git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$STAGE" -f -

# ── Frontend (prebuilt dist is shipped; servers never build it) ───────
case "$FRONTEND_MODE" in
  build)
    command -v npm >/dev/null 2>&1 || die "npm is required to build the frontend (or use --skip-frontend-build)"
    [[ -f "${STAGE}/frontend/package-lock.json" ]] || die "frontend/package-lock.json missing at HEAD"
    log "Building frontend (npm ci && npm run build)"
    ( cd "${STAGE}/frontend" && npm ci --no-audit --no-fund && npm run build ) || die "frontend build failed"
    rm -rf -- "${STAGE}/frontend/node_modules"
    DIST_SRC="${STAGE}/frontend/dist"
    ;;
  skip) DIST_SRC="${REPO_ROOT}/frontend/dist" ;;
  dir)  DIST_SRC=$FRONTEND_DIST ;;
esac
[[ -f "${DIST_SRC}/index.html" ]] || die "frontend build not found: ${DIST_SRC}/index.html"
if [[ -n $(find "$DIST_SRC" \( -type l -o ! -type f ! -type d \) -print -quit) ]]; then
  die "frontend dist contains symlinks or special files"
fi
if [[ $DIST_SRC != "${STAGE}/frontend/dist" ]]; then
  rm -rf -- "${STAGE}/frontend/dist"
  mkdir -p -- "${STAGE}/frontend"
  cp -R -- "$DIST_SRC" "${STAGE}/frontend/dist"
fi
printf '%s\n' "$VERSION" > "${STAGE}/VERSION"

# The updaters reject archives with links or special files — fail early here.
if [[ -n $(find "$STAGE" \( -type l -o ! -type f ! -type d \) -print -quit) ]]; then
  die "release tree contains symlinks or special files (not allowed in releases)"
fi

# ── Tarball (reproducible) ───────────────────────────────────────────
EPOCH=$(git -C "$REPO_ROOT" log -1 --format=%ct HEAD)
TARBALL="${OUT}/${NAME}.tar.gz"
log "Creating ${TARBALL##*/}"
rm -f -- "$TARBALL" "${OUT}/SHA256SUMS" "${OUT}/SHA256SUMS.sig"
( cd "$WORK" && LC_ALL=C tar --sort=name --format=gnu \
    --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' --mtime="@${EPOCH}" \
    -cf - "$NAME" ) | gzip -n -9 > "${TARBALL}.tmp"
mv -f -- "${TARBALL}.tmp" "$TARBALL"

# ── Checksums + signature ────────────────────────────────────────────
sum=$(tv_sha256 "$TARBALL") || die "hashing failed"
printf '%s  %s\n' "$sum" "${NAME}.tar.gz" > "${OUT}/SHA256SUMS"
log "SHA256SUMS: ${sum}  ${NAME}.tar.gz"

if $SIGN; then
  "${SCRIPT_DIR}/sign-release.sh" "$OUT" ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} || die "signing failed"
else
  log "Unsigned build (sign with scripts/release/sign-release.sh ${OUT})"
fi
log "Release artifacts in ${OUT}:"
find "$OUT" -maxdepth 1 -type f -printf '    %f (%s bytes)\n' | sort
