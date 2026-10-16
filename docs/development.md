# Development

This page collects the developer-facing details that used to live in the README.
For contribution rules, see [CONTRIBUTING.md](../CONTRIBUTING.md); for the source
layout, see [Project structure](project-structure.md).

## Run from source

```bash
git clone https://github.com/realDuang/codemux.git
cd codemux
bun install
bun run update:cloudflared   # Cloudflare Tunnel binary, for remote access
bun run dev                  # Electron + Vite HMR
```

## Commands

```bash
./scripts/server-init.sh  # Bootstrap a Linux server before Bun is installed
bun run dev                # Electron + Vite HMR
bun run dev:isolated       # Electron dev instance with its own state and ports (see below)
bun run server:dev         # Foreground Node + Vite development
bun run server:up          # Background Node + Vite development
bun run server:tunnel      # Background Node + Vite development + quick tunnel
bun run server:restart     # Restart the managed development host
bun run server:access-code # Print the current 6-digit access code
bun run server:access-requests # Interactively review pending remote access requests
bun run server:down        # Stop the managed development host
bun run server:status      # Show managed development status
bun run build              # Build Electron and Web/PWA clients
bun run build:desktop      # Desktop shell, local Server, and shared UI
bun run build:web          # Shared UI in out/web plus thin desktop HTML
bun run build:server-app   # Pure Node Server/CLI and Web UI
bun run pack:server        # Target-platform standalone directory package
bun run dist:mac:arm64     # macOS Apple Silicon
bun run dist:mac:x64       # macOS Intel
bun run dist:win           # Windows NSIS installer
bun run typecheck          # Type checking
bun run update:cloudflared # Update Cloudflare Tunnel binary
```

## Isolated Electron dev instances

Use isolated dev mode when you want to debug CodeMux from a separate git worktree without interrupting your normal running app session:

```bash
bun run dev:isolated
```

This keeps `bun run dev` unchanged. The isolated command writes all Electron app state for that worktree under a gitignored `.codemux-dev/` directory:

```text
.codemux-dev/
  userData/
  sessionData/
  logs/
  ports.json
```

Each worktree can have its own `.codemux-dev/` directory and port allocation. The first run automatically reserves a non-default port offset and stores it in `.codemux-dev/ports.json`; later runs reuse that saved offset so the same worktree stays stable. If the saved ports become stale or conflict with another process, stop the existing isolated instance, delete `.codemux-dev/ports.json` to reallocate, or set an explicit `CODEMUX_PORT_OFFSET`.

Supported port overrides:

- `CODEMUX_PORT_OFFSET`
- `CODEMUX_WEB_PORT`
- `CODEMUX_WEB_STANDALONE_PORT`
- `CODEMUX_GATEWAY_PORT`
- `CODEMUX_OPENCODE_PORT`
- `CODEMUX_AUTH_API_PORT`
- `CODEMUX_WEBHOOK_PORT`

## Linux server from source

```bash
# Build and run the production server from this checkout
bun install --frozen-lockfile
bun run build:server-app
node out/server/index.mjs

# Manage the running host from another terminal
node out/server/cli.mjs status
node out/server/cli.mjs access-code
node out/server/cli.mjs pending
node out/server/cli.mjs stop
```

Use `--data-dir /absolute/path` on both the production server and CLI to select an existing data directory. Development wrappers retain their legacy device-file and isolation conventions. `bun run start` remains the legacy OpenCode/Vite compatibility entry on port 8234, with `.devices.json` and `.settings.json` in its working directory; it is separate from the complete Node host.

See [Server runtime and distribution](server-runtime.md) for directory packages, service management, data paths, and upgrades.

## Adding a new engine

Implement `EngineAdapter` (see `electron/main/engines/engine-adapter.ts`), add tool name mapping in `src/types/tool-mapping.ts`, and register in `electron/main/index.ts`. All engine-specific logic stays in the adapter layer; the frontend renders only unified types.
