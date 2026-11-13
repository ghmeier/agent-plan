#!/bin/sh
# Installs the apl CLI as a standalone binary from a GitHub release of
# ghmeier/agent-plan. No Node or Bun needed, and no sudo.
#
# The binary is checked against the release's SHA256SUMS before it is
# installed. When the GitHub CLI (gh) is available, its build provenance is
# also verified, which proves it was built by this repository's release
# workflow from the tagged commit.
#
# Settings, all optional, read from the environment:
#   APL_VERSION              release tag to install, such as v0.8.0 (default: latest)
#   APL_INSTALL_DIR          where to put the binary (default: ~/.local/bin)
#   APL_REQUIRE_ATTESTATION  set to 1 to fail when provenance can't be verified
#
# Read it before running it. To install:
#   curl -fsSLO https://github.com/ghmeier/agent-plan/releases/latest/download/install.sh
#   less install.sh
#   sh install.sh

set -eu

REPO="ghmeier/agent-plan"

# Everything runs from main, called on the last line, so a download cut off
# partway through runs nothing.
main() {
  need uname
  need mktemp
  need chmod
  need mv

  target="$(detect_target)"
  version="${APL_VERSION:-$(latest_version)}"
  case "$version" in
    v*) ;;
    *) version="v$version" ;;
  esac
  install_dir="${APL_INSTALL_DIR:-$HOME/.local/bin}"
  asset="apl-$target"
  base="https://github.com/$REPO/releases/download/$version"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading apl $version for $target"
  download "$base/$asset" "$tmp/$asset"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

  verify_checksum "$tmp" "$asset"
  verify_attestation "$tmp/$asset"

  mkdir -p "$install_dir"
  chmod 755 "$tmp/$asset"
  # Move into place in one step so a running apl is never half-written.
  mv -f "$tmp/$asset" "$install_dir/apl.tmp.$$"
  mv -f "$install_dir/apl.tmp.$$" "$install_dir/apl"
  say "Installed apl $version to $install_dir/apl"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) say "$install_dir is not on your PATH. Add it to your shell config, for example:
    export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

say() {
  printf '%s\n' "$*" >&2
}

fail() {
  say "error: $*"
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "this installer needs '$1', which isn't installed"
}

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "no prebuilt apl for $os. Install with npm instead: npm i -g @ghmeier/agent-plan" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "no prebuilt apl for $arch. Install with npm instead: npm i -g @ghmeier/agent-plan" ;;
  esac
  # An x64 shell under Rosetta reports x86_64 on Apple silicon. Prefer the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  printf '%s-%s\n' "$os" "$arch"
}

# HTTPS only, including redirects, with TLS 1.2 or later.
download() {
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1" || fail "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --secure-protocol=TLSv1_2 -q -O "$2" "$1" || fail "could not download $1"
  else
    fail "this installer needs curl or wget"
  fi
}

# The latest release's tag, from where GitHub redirects /releases/latest.
# Avoids the API, which rate-limits anonymous callers.
latest_version() {
  url=""
  if command -v curl >/dev/null 2>&1; then
    url="$(curl --proto '=https' --tlsv1.2 -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest")" || true
  elif command -v wget >/dev/null 2>&1; then
    url="$(wget --https-only --secure-protocol=TLSv1_2 -q -S --spider \
      "https://github.com/$REPO/releases/latest" 2>&1 |
      sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')" || true
  fi
  tag="${url##*/tag/}"
  case "$url" in
    */tag/v*) printf '%s\n' "$tag" ;;
    *) fail "could not find the latest release. Set APL_VERSION, for example APL_VERSION=v0.8.0" ;;
  esac
}

verify_checksum() {
  expected="$(awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }' "$1/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $2"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1/$2" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$1/$2" | awk '{ print $1 }')"
  else
    fail "this installer needs sha256sum or shasum to verify the download"
  fi
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $2 (expected $expected, got $actual). Not installing."
  say "Checksum verified"
}

# SHA256SUMS comes from the same release as the binary, so it catches a
# corrupted download but not a tampered release. The attestation is signed by
# GitHub for the workflow run that built the binary, so it catches both.
verify_attestation() {
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    [ "${APL_REQUIRE_ATTESTATION:-0}" = 1 ] &&
      fail "APL_REQUIRE_ATTESTATION is set, but verifying provenance needs the GitHub CLI (gh), logged in"
    say "Skipping the provenance check, which needs the GitHub CLI (gh), logged in. To check by hand:"
    say "  gh attestation verify $install_dir/apl --repo $REPO"
    return 0
  fi
  gh attestation verify "$1" --repo "$REPO" >/dev/null ||
    fail "the binary's provenance did not verify, so it may not have been built by $REPO. Not installing."
  say "Provenance verified: built by $REPO's release workflow"
}

main "$@"
