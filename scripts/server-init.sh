#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
RUN_SETUP=1

usage() {
  cat <<'EOF'
Usage: ./scripts/server-init.sh [--skip-setup]

Prepare a Debian/Ubuntu-style Linux server for CodeMux development:
  - install native build tools for the Node.js server (Node.js 24+ required)
  - install Bun if it is missing
  - install repository dependencies with bun install
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

  command -v node >/dev/null 2>&1 || fail "Install Node.js 24 or newer before running this helper."
  node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || \
    fail "Node.js 24 or newer is required; update the node command on PATH first."

  local packages=(curl git unzip ca-certificates python3 make g++ pkg-config)

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
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile

  success "Linux server bootstrap is ready."

  if [ "$RUN_SETUP" -eq 1 ]; then
    info "Running interactive CodeMux setup..."
    bun run setup
  else
    warn "Skipped bun run setup. Run it later to install engine dependencies."
  fi

  cat <<'EOF'

Next steps:
  bun run server:dev      # foreground watched Node server
  bun run server:up       # background watched Node server
  bun run server:tunnel   # background watched Node server + quick tunnel
  bun run server:restart  # restart the owned runtime; quick-tunnel URL may change
  bun run start           # legacy web-only compatibility entry
EOF
}

main "$@"
