# Server runtime and distribution

CodeMux has one host implementation and two clients. The Node host owns engines, sessions, authentication, channels, scheduling, files, Git/worktrees, orchestration, and PTYs. Electron supervises a local host and provides native desktop integration. The browser/PWA connects through the existing HTTP and WebSocket APIs. Engine and service sources remain in their existing directories where moving files would add no behavior benefit; the Node build verifies that its import graph excludes Electron and native desktop modules.

## Build and run

Use Node 24 and Bun for development/builds. The production directory package needs Node 24 at runtime. Engine executables, their credentials, and optional Cloudflare configuration retain their existing installation requirements.

```sh
bun install --frozen-lockfile
bun run build:server-app
node out/server/index.mjs --data-dir /absolute/data/path --port 8233
node out/server/cli.mjs --data-dir /absolute/data/path status
```

The compiled installation root is derived from the executable module, so the server can start from another working directory. `--app-dir` explicitly overrides that root. The default standalone host serves `out/web` and `/ws` on one HTTP port. `--help` lists path overrides. Live operations require the host; PWA offline mode only retains its static shell and local text drafts.

`build:desktop` and `build` additionally produce the Electron main/preload and a thin desktop HTML entry. The two clients share the production business JS/CSS. Electron can start, stop, and restart its own local child; if it attaches to an existing host, closing Electron leaves that host running and restarting it requires its original launcher. Server management remains reachable inside Electron when the child is stopped.

## Data and ownership

Default data directories retain the desktop conventions:

| Platform | Default |
| --- | --- |
| macOS | `~/Library/Application Support/codemux` |
| Windows | `%APPDATA%/codemux` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/codemux` |

`CODEMUX_DATA_DIR` or `--data-dir` selects an explicit root. `--devices-file` preserves a separately stored identity file; `--logs-dir` selects the log location. Normal settings, device IDs/JWTs, conversations, channel configuration, tasks, and worktree metadata keep their existing formats. The parent desktop log is `desktop.log`; the host retains `main.log`.

Each data directory has one active runtime owner. The private `runtime-control.json` file identifies that owner and is readable only by the local account. CLI operations contact it; they do not bypass the running process to write settings or device files. Normal stop drains admitted operations and pending writes, closes clients, and stops owned children before releasing the lock. After a hard crash, allow the 30-second stale lease to expire before retrying; do not delete a live owner's lock.

## Local management

```sh
node out/server/cli.mjs --data-dir /absolute/data/path access-code
node out/server/cli.mjs --data-dir /absolute/data/path pending
node out/server/cli.mjs --data-dir /absolute/data/path approve REQUEST_ID
node out/server/cli.mjs --data-dir /absolute/data/path channels list
node out/server/cli.mjs --data-dir /absolute/data/path settings get
node out/server/cli.mjs --data-dir /absolute/data/path stop
```

The CLI also supports device denial, remote-access settings, channel configuration/lifecycle, and existing local management operations; run `help` for the full list. Public Web device credentials do not authorize the private owner endpoint. Existing remote policy and secret-redaction rules are unchanged.

## Development commands

`server:dev` runs the Node host plus Vite in the foreground; `server:up` starts the same supervised stack in the background. Successful backend rebuilds restart the owned runtime, while a failed build leaves the last working service running. UI source updates use Vite. `server:down` stops the managed development stack, including its watchers. `server:restart` replaces the managed development stack using the calling checkout and environment, preserving the legacy explicit-restart behavior; automatic source rebuilds only restart its owned runtime. `server:status` reads the private status.

These wrappers retain `cwd/.devices.json` in ordinary legacy development and the existing `.codemux-dev` paths and allocated ports in isolated development. Their global/per-checkout management state remains separate from runtime data. They do not stop unrelated servers based on port numbers or a matching command line. Quick tunnels remain owned by the runtime; their temporary URL can change after restart.

The older `bun run start` entry is retained separately: it uses port 8234, `cwd/.devices.json`, `cwd/.settings.json`, and its original OpenCode/Vite authentication behavior. It does not become an alias for the complete Node host. Desktop development remains `bun run dev` or `bun run dev:isolated`.

## Directory packages

Run `bun run pack:server` on the target OS and CPU architecture. Packaging builds the host and Web client, installs the locked production dependencies in a new staging directory, verifies native loading, and produces a relocatable directory under `release`. It does not bundle Electron or build tools. The directory contains `out/server`, `out/web`, a runtime manifest, and target-platform `node_modules`.

SDK optional dependencies and native binaries must match the target. Linux builds require Python 3, make, and a C++ compiler for node-pty. Do not copy macOS or Windows `node_modules` into Linux. Installation and packaging prepare the node-pty helper's executable permissions, and Electron packages explicitly unpack native dependencies. Existing Electron DMG/NSIS/AppImage/deb products remain desktop packages.

Cloudflared is resolved from PATH by default in the standalone server. To use an explicitly bundled resource tree, set `CODEMUX_BUNDLED_RESOURCES=1` and `CODEMUX_RESOURCES_PATH` to the matching resources directory. Merely placing a binary beside the server does not change lookup policy.

## Service installation and updates

A process manager can execute the package's absolute `out/server/index.mjs` path with Node 24. Set the data directory explicitly, supply the normal engine PATH/environment, and allow at least 45 seconds for graceful stop. For example, adapt this user-level systemd service to the actual package, Node executable, data directory, and installed engine paths:

```ini
[Unit]
Description=CodeMux Server
After=network.target

[Service]
Type=exec
ExecStart=/usr/bin/node /opt/codemux/current/out/server/index.mjs --data-dir %h/.config/codemux
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
TimeoutStopSec=45

[Install]
WantedBy=default.target
```

For an update, build a new target-platform directory, stop the current owner and wait for it to exit, preserve the data directory, then switch the process manager to the new package and verify CLI status and the existing Web login/history. Keep the prior package for rollback; stop the new owner before starting the old package against the same data. Do not replace native dependencies or package files beneath an active process. Web clients receive the usual explicit PWA update prompt; old open tabs retain their version caches.

The migration uses no new persistent data format. Validation evidence and remaining platform/device limits are recorded in [the migration checkpoints](architecture-migration.md).
