#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.bun/bin:$HOME/.opencode/bin:$PATH"
command -v bun >/dev/null 2>&1 || {
  printf 'Missing required command: bun\n' >&2
  exit 1
}
exec bun "$SCRIPT_DIR/server-dev.ts" "$@"
