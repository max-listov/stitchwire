#!/usr/bin/env bash
# Stitchwire standalone runtime installer — idempotent, integrity-checked, zero jq dependency:
#   curl -fsSL https://raw.githubusercontent.com/max-listov/stitchwire/main/contrib/install.sh | bash
#
# Installs the standalone `stitchwire` runtime into $STITCHWIRE_PREFIX/bin/stitchwire
# (default ~/.local/bin/stitchwire) and, on macOS, places its native lock-identity sidecar at
# $STITCHWIRE_PREFIX/native/darwin-<arch>.node. Re-running on an up-to-date machine fetches only
# the signed checksum list and manifest and changes no files.
#
# The release signer authenticates SHA256SUMS with Ed25519. Its public key ships in this installer,
# independently of the asset mirror. The checksum list covers manifest.json and every executable.
# Every file is downloaded and checked, and the new runtime answers `--version` from a
# staged copy, before any installed file is replaced. Downloads are https only; a plain http:// base
# is accepted for this machine alone (127.0.0.0/8, ::1, localhost), and no redirect leaves https.
# The candidate file name is not taken from the manifest: it is stitchwire-<version>, and the manifest
# must say exactly that. This installer is for a single machine; it is not how a fleet rolls back.
#
# Requires bash, curl, awk and sha256sum or shasum. Bun must already be installed
# (https://bun.sh); this script never installs it.
#
# Environment overrides:
#   STITCHWIRE_REPO          GitHub owner/repo (default: max-listov/stitchwire)
#   STITCHWIRE_VERSION       Pin a specific version, e.g. 0.57.0 or v0.57.0 (default: latest)
#   STITCHWIRE_RELEASE_BASE  Override release asset base URL (for mirrors or isolated tests)
#   STITCHWIRE_PREFIX        Installation prefix (default: $HOME/.local)
#   STITCHWIRE_BUN           Explicit path to bun executable (default: `bun` on PATH, then ~/.bun/bin/bun)
set -euo pipefail
RELEASE_PUBLIC_KEY='0MFAOg326fFnUfZakiWAzOjZaTZn4iqby-r2mntzB2c'

say() { printf 'stitchwire-install: %s\n' "$1"; }
die() { printf 'stitchwire-install: error: %s\n' "$1" >&2; exit 1; }

sha_of() { # $1=file; prints nothing for a missing file
  [ -f "$1" ] || return 0
  "${SHA_TOOL[@]}" "$1" | awk '{print $1}'
}

expected_sha() { # $1=sums_file $2=filename
  awk -v target="$2" '$2 == target { print $1; exit }' "$1"
}

candidate_field() { # $1=string field of the manifest's "candidate" object, whatever the layout
  awk -v field="$1" '
    { text = text $0 "\n" }
    END {
      # The object itself, not the first line that mentions it: no other key holds an object
      # named "candidate", and the object holds no nested object.
      if (!match(text, /"candidate"[[:space:]]*:[[:space:]]*[{][^{}]*[}]/)) exit
      object = substr(text, RSTART, RLENGTH)
      if (!match(object, "\"" field "\"[[:space:]]*:[[:space:]]*\"[^\"]*\"")) exit
      value = substr(object, RSTART, RLENGTH)
      sub(/^[^:]*:[[:space:]]*"/, "", value)
      sub(/"$/, "", value)
      print value
    }
  ' "${TMP}/manifest.json"
}

# Sets PROTO, the protocols curl may use for the base $1: https, or http for this machine only
# (the same loopback rule the agent applies to a broker lane).
release_protocols() {
  local rest authority host
  case "$1" in
    https://*) PROTO='=https'; return ;;
    http://*) rest="${1#http://}" ;;
    *) die "STITCHWIRE_RELEASE_BASE must be an https:// URL (http:// on loopback only)" ;;
  esac
  authority="${rest%%/*}"
  case "$authority" in
    *@*) die "STITCHWIRE_RELEASE_BASE must not carry credentials" ;;
    \[*) host="${authority%%]*}]" ;;
    *) host="${authority%%:*}" ;;
  esac
  if [ "$host" = "localhost" ] || [ "$host" = "[::1]" ] || [[ "$host" =~ ^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    # A loopback mirror may still redirect to https; --proto-redir keeps every redirect on https.
    PROTO='=http,https'
  else
    die "plain http:// is refused outside loopback (127.0.0.0/8, ::1, localhost); use an https:// STITCHWIRE_RELEASE_BASE"
  fi
}

fetch() { # $1=url $2=output file
  curl -fsSL --proto "$PROTO" --proto-redir '=https' "$1" -o "$2"
}

# Phase 2 bookkeeping, read by the EXIT trap. While REPLACING is 1 the installed pair is between two
# states, so an exit for any reason — a failed mv, INT, TERM — puts the previous files back, or removes
# the new ones where there were none.
REPLACING=0
SUFFIX="$$"
DESTS=()
REPLACED=()

restore_previous() {
  local i
  # bash 3.2, the macOS system shell, calls an empty array unbound under `set -u`.
  [ "${#REPLACED[@]}" -gt 0 ] || return 0
  for i in "${REPLACED[@]}"; do
    if [ -f "${DESTS[$i]}.prev.${SUFFIX}" ]; then
      mv -f "${DESTS[$i]}.prev.${SUFFIX}" "${DESTS[$i]}" || true
    else
      rm -f "${DESTS[$i]}"
    fi
  done
}

cleanup() {
  local status=$? i
  trap - EXIT
  if [ "$REPLACING" = 1 ]; then
    restore_previous
    printf 'stitchwire-install: error: interrupted while replacing files; the previous installation was put back\n' >&2
  fi
  [ "${#DESTS[@]}" -eq 0 ] || for i in "${!DESTS[@]}"; do
    rm -f "${DESTS[$i]}.install.${SUFFIX}" "${DESTS[$i]}.prev.${SUFFIX}"
  done
  [ -z "${TMP:-}" ] || rm -rf "$TMP"
  exit "$status"
}

# The whole script is one function called on its last line, so a download cut short runs nothing.
main() {
  local repo="${STITCHWIRE_REPO:-max-listov/stitchwire}"
  local prefix="${STITCHWIRE_PREFIX:-${HOME}/.local}"
  local bin_dir="${prefix}/bin"
  local native_dir="${prefix}/native"
  local os raw_arch platform arch base

  os="$(uname -s)"
  raw_arch="$(uname -m)"
  case "$os" in
    Darwin) platform="darwin" ;;
    Linux)  platform="linux" ;;
    *)      die "unsupported OS '${os}' (Stitchwire runtime supports Linux and macOS only)" ;;
  esac
  case "$raw_arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *)             die "unsupported architecture '${raw_arch}' (supported: arm64, x64)" ;;
  esac

  if [ -n "${STITCHWIRE_RELEASE_BASE:-}" ]; then
    base="${STITCHWIRE_RELEASE_BASE%/}"
    release_protocols "$base"
  elif [ -n "${STITCHWIRE_VERSION:-}" ]; then
    base="https://github.com/${repo}/releases/download/v${STITCHWIRE_VERSION#v}"
  else
    base="https://github.com/${repo}/releases/latest/download"
  fi
  [ -n "${PROTO:-}" ] || PROTO='=https'

  # ── tools ─────────────────────────────────────────────────────────────────────
  command -v curl >/dev/null 2>&1 || die "curl is required to download the release"
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    SHA_TOOL=(shasum -a 256)
  else
    die "sha256sum or shasum is required to verify the downloads; install one and run again"
  fi

  local bun="${STITCHWIRE_BUN:-$(command -v bun || true)}"
  if [ -z "$bun" ] && [ -x "${HOME}/.bun/bin/bun" ]; then
    bun="${HOME}/.bun/bin/bun"
  fi
  [ -n "$bun" ] || die "bun not found: install it first (https://bun.sh) or set STITCHWIRE_BUN"
  [ -x "$bun" ] || die "bun executable not found or not executable: ${bun}"

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  TMP="$(mktemp -d)"

  say "fetching release manifest from ${base}…"
  fetch "${base}/manifest.json" "${TMP}/manifest.json" || die "cannot fetch ${base}/manifest.json"
  fetch "${base}/SHA256SUMS" "${TMP}/SHA256SUMS" || die "cannot fetch ${base}/SHA256SUMS"

  # The first public release predates signatures. Only an explicit pin to its exact published
  # checksum list can select it; unsigned bytes from a mirror never become a new latest release.
  if [[ "${STITCHWIRE_VERSION:-}" =~ ^v?0\.58\.0$ ]] && [ "$(sha_of "${TMP}/SHA256SUMS")" = '6a421ba23c4c3dff000f0a91dec7cda5fa0a348eba78d2f1528d2c0b45b69a7c' ]; then
    say 'verified pinned 0.58.0 checksum list'
  else
    fetch "${base}/SHA256SUMS.sig" "${TMP}/SHA256SUMS.sig" || die 'cannot fetch release checksum signature'
    "$bun" --no-install -e '
      const {createPublicKey, verify} = require("node:crypto");
      const {readFileSync} = require("node:fs");
      const [x, sums, sig] = process.argv.slice(1);
      const key = createPublicKey({format:"jwk", key:{kty:"OKP", crv:"Ed25519", x}});
      const signature = readFileSync(sig);
      process.exit(signature.length === 64 && verify(null, readFileSync(sums), key, signature) ? 0 : 1);
    ' "$RELEASE_PUBLIC_KEY" "${TMP}/SHA256SUMS" "${TMP}/SHA256SUMS.sig" || die 'invalid release checksum signature'
  fi

  # Check manifest.json itself against SHA256SUMS before trusting its fields.
  local want_manifest got_manifest
  want_manifest="$(expected_sha "${TMP}/SHA256SUMS" "manifest.json")"
  [ -n "$want_manifest" ] || die "SHA256SUMS does not list manifest.json"
  got_manifest="$(sha_of "${TMP}/manifest.json")"
  [ "$got_manifest" = "$want_manifest" ] || die "manifest.json checksum mismatch (expected ${want_manifest}, got ${got_manifest})"

  # The file name is derived from the version, so a manifest cannot name a path or another file.
  local version candidate
  version="$(candidate_field version)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "manifest.json does not declare a candidate.version of the form X.Y.Z"
  # A pinned version is what the caller asked for: a mirror or release that serves another one is refused.
  [ -z "${STITCHWIRE_VERSION:-}" ] || [ "$version" = "${STITCHWIRE_VERSION#v}" ] \
    || die "the release names version ${version}, not the requested ${STITCHWIRE_VERSION#v}"
  candidate="stitchwire-${version}"
  [ "$(candidate_field file)" = "$candidate" ] || die "manifest.json candidate.file is not ${candidate}"

  # staged: the same bin/ + native/ layout inside $TMP, so the new pair runs as it will be installed.
  local remotes=("$candidate") staged=("${TMP}/install/bin/stitchwire") modes=(0755)
  DESTS=("${bin_dir}/stitchwire")
  if [ "$platform" = "darwin" ]; then
    remotes+=("${candidate}.darwin-${arch}.node")
    staged+=("${TMP}/install/native/darwin-${arch}.node")
    DESTS+=("${native_dir}/darwin-${arch}.node")
    modes+=(0644)
  fi

  # Phase 1: download and check every changed file; nothing installed is touched yet.
  local i want got pending=""
  for i in "${!remotes[@]}"; do
    want="$(expected_sha "${TMP}/SHA256SUMS" "${remotes[$i]}")"
    [ -n "$want" ] || die "SHA256SUMS does not list ${remotes[$i]}"
    mkdir -p "$(dirname "${staged[$i]}")"
    if [ "$(sha_of "${DESTS[$i]}")" = "$want" ]; then
      say "${DESTS[$i]}: already ${version} (unchanged)"
      cp "${DESTS[$i]}" "${staged[$i]}"
      continue
    fi
    say "downloading ${remotes[$i]}…"
    fetch "${base}/${remotes[$i]}" "${staged[$i]}" || die "cannot fetch ${base}/${remotes[$i]}"
    got="$(sha_of "${staged[$i]}")"
    [ "$got" = "$want" ] || die "${remotes[$i]} checksum mismatch (expected ${want}, got ${got}); existing installation untouched"
    pending="${pending} ${i}"
  done

  # The staged runtime, with its staged native module beside it, must be the version the manifest names.
  local staged_version
  staged_version="$("$bun" "${staged[0]}" --version 2>/dev/null | tr -d '\r\n' || true)"
  [ "$staged_version" = "$version" ] || die "the downloaded binary reported '${staged_version}', expected '${version}'; existing installation untouched"

  # Phase 2: copy each changed file beside its destination and keep the previous one, then move the
  # new files into place; each move is atomic within its directory, and the trap covers the gap
  # between them.
  for i in $pending; do
    mkdir -p "$(dirname "${DESTS[$i]}")"
    cp "${staged[$i]}" "${DESTS[$i]}.install.${SUFFIX}"
    chmod "${modes[$i]}" "${DESTS[$i]}.install.${SUFFIX}"
    [ ! -f "${DESTS[$i]}" ] || cp -p "${DESTS[$i]}" "${DESTS[$i]}.prev.${SUFFIX}"
  done
  REPLACING=1
  for i in $pending; do
    REPLACED+=("$i")
    mv -f "${DESTS[$i]}.install.${SUFFIX}" "${DESTS[$i]}"
  done
  REPLACING=0
  for i in $pending; do
    say "${DESTS[$i]}: installed ${version} (checksum matches SHA256SUMS)"
  done
  say "ready: stitchwire ${version} (${platform}-${arch})"

  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *) say "note: add ${bin_dir} to your PATH to invoke \`stitchwire\` directly" ;;
  esac
}

main "$@"
