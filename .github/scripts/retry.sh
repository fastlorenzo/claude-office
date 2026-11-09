# shellcheck shell=bash
# Source me: `. .github/scripts/retry.sh`, then `retry <cmd...>`.
#
# Retries a network-bound command with backoff. GitHub release downloads
# intermittently return 504 for minutes at a time, so from the third attempt
# on, GitHub release assets are fetched from the npmmirror.com mirror instead.
# That is integrity-safe because every such download is checksum-verified
# against values that do not come from the mirror:
#   - Electron zips: node_modules/electron/checksums.json (shipped in the npm
#     package from registry.npmjs.org), enforced by electron's install.js;
#   - electron-builder tool archives (NSIS, AppImage, winCodeSign, 7zip, ...):
#     checksums pinned in app-builder-lib/out/toolsets.
retry() {
  local attempt
  for attempt in 1 2 3 4; do
    if [ "$attempt" -ge 3 ]; then
      export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
      export ELECTRON_CUSTOM_DIR="{{ version }}"
      export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
      echo "retry: using the checksum-verified npmmirror fallback for GitHub release assets"
    fi
    if "$@"; then
      return 0
    fi
    echo "retry: attempt $attempt failed: $*"
    sleep $((attempt * 20))
  done
  return 1
}
