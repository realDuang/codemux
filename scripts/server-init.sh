#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
RUN_SETUP=1

usage() {
  cat <<'EOF'
Usage: ./scripts/server-init.sh [--skip-setup]

Prepare a Debian/Ubuntu-style Linux server for CodeMux development:
  - install Electron runtime dependencies for headless environments
  - install Bun if it is missing
  - install repository dependencies with bun install
  - fix chrome-sandbox permissions for Electron
  - optionally run the interactive bun run setup flow
EOF
}

info() {
  printf '[36m> %s[0m
' "$*"
}

success() {
  printf '[32m[ok][0m %s
' "$*"
}

warn() {
  printf '[33m[!][0m %s
' "$*"
}

fail() {
  printf '[31m[x][0m %s
' "$*" >&2
  exit 1
}

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

has_apt_candidate() {
  local candidate
  candidate=$(apt-cache policy "$1" | awk '$1 == "Candidate:" { print $2; exit }')
  [ -n "$candidate" ] && [ "$candidate" != "(none)" ]
}

choose_available_package() {
  local pkg
  for pkg in "$@"; do
    if has_apt_candidate "$pkg"; then
      printf '%s
' "$pkg"
      return 0
    fi
  done
  return 1
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --skip-setup)
        RUN_SETUP=0
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done

  [ "$(uname -s)" = "Linux" ] || fail "This helper currently supports Linux only."
  command -v apt-get >/dev/null 2>&1 || fail "This helper currently supports apt-based distributions only."

  if [ "${EUID}" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    fail "sudo is required to install Linux packages."
  fi

  local asound_pkg
  asound_pkg=$(choose_available_package libasound2t64 libasound2) || fail "Unable to find a usable libasound2 package."

  local packages=(
    curl
    git
    unzip
    dbus-x11
    xvfb
    libnss3
    libxss1
    libxtst6
    libdrm2
    libgbm1
    libxrandr2
    libxdamage1
    libxcomposite1
    libxkbcommon0
    libcairo2
    libpango-1.0-0
    libatk-bridge2.0-0
    libgtk-3-0
    "$asound_pkg"
  )

  info "Installing Linux server dependencies..."
  run_as_root apt-get update
  run_as_root apt-get install -y "${packages[@]}"

  if ! command -v bun >/dev/null 2>&1; then
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
  fi

  export PATH="$HOME/.bun/bin:$HOME/.opencode/bin:$PATH"

  cd "$REPO_DIR"
  info "Installing repository dependencies with Bun..."
  bun install

  local sandbox="$REPO_DIR/node_modules/electron/dist/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    info "Configuring chrome-sandbox permissions..."
    run_as_root chown root:root "$sandbox"
    run_as_root chmod 4755 "$sandbox"
  else
    warn "chrome-sandbox not found yet; skipping permission fix."
  fi

  success "Linux server bootstrap is ready."

  if [ "$RUN_SETUP" -eq 1 ]; then
    info "Running interactive CodeMux setup..."
    bun run setup
  else
    warn "Skipped bun run setup. Run it later to install engine dependencies."
  fi

  cat <<'EOF'

Next steps:
  bun run server:dev      # foreground headless Electron dev
  bun run server:up       # background headless Electron dev
  bun run server:tunnel   # background headless Electron dev + quick tunnel
  bun run start           # web-only standalone server
EOF
}

main "$@"
