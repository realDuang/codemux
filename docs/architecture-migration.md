# Server runtime architecture

CodeMux runs one reusable host behind the Electron and Web/PWA clients. Electron supervises a local Node process and retains native integration; the standalone Server uses Node 24 without Electron, a display server, or a desktop session. Both clients use the same compiled business UI and existing Gateway protocol.

The migration builds on the PWA work in [PR #164](https://github.com/realDuang/codemux/pull/164) and retains the published Codex Desktop integration from [PR #165](https://github.com/realDuang/codemux/pull/165). It preserves existing engine capabilities, session identities, authentication policy, data formats, and user preferences.

## Ownership and boundaries

| Component | Responsibility |
| --- | --- |
| `server/service-host.ts` | Compose engines, channels, Gateway, management, and shared lifecycle |
| `shared/service-runtime.ts` | Initialize services, report readiness, and coordinate shutdown |
| `server/runtime-host.ts` | Supply Node paths, resource lookup, logging, and runtime policy |
| `electron/main/app-main.ts` | Keep native windows, tray, notifications, updates, and local supervision |
| `electron/main/local-server-supervisor.ts` | Start, discover, stop, and restart the local host |
| `shared/host-management.ts` | Implement business operations shared by IPC and local management |
| `shared/host-control-server.ts` | Expose authenticated local owner control on a private loopback listener |
| `server/cli.ts` | Manage the owner of a selected data directory |

Engine, Gateway, channel, and service sources retain their existing directories where moving files would add no behavior benefit. The Server build checks every emitted chunk for Electron, updater, and native-shell dependencies. Host adapters provide the platform-specific behavior instead of importing Electron from reusable services.

The host retains OpenCode, Copilot, Claude Code, and Codex. Codex Desktop sharing remains opt-in with the same environment-over-settings precedence. Its catalog uses the host's existing data directory and stable native IDs. The sharing service detaches external Desktop owners and stops only execution processes owned by CodeMux.

## Data and shutdown

Existing data roots and formats are unchanged. Runtime paths are resolved before services initialize. Settings keep their shallow object-merge behavior and atomic writes; browser preferences retain their existing local scope.

A data directory has one owner, protected by a renewable lock. The private control endpoint binds to `127.0.0.1` on an ephemeral port and uses a random per-instance credential stored in mode-0600 metadata. Clients can require the exact instance ID. Web device JWTs cannot authorize owner operations, and the endpoint provides no CORS access.

The Electron parent reads persisted settings synchronously for bootstrap. Writes go through the active owner; while stopped, the parent acquires the same lock before writing. Parent logging uses `desktop.log`, while the host retains `main.log`.

Shutdown stops watchers and owner-scoped PTYs, closes Gateway clients before waiting on HTTP shutdown, stops engines/channels/scheduling/tunnels, and drains pending persistence. Authoritative Desktop snapshots and removals participate in the same write drain. Pending engine startup cannot leave a late child running after shutdown. Loss of lock ownership stops owned descendants without writing or releasing a replacement owner's lock.

The desktop supervisor distinguishes its own child from an externally launched local host. Electron exit leaves an external host running. Restarting an external host requires its original launcher so its configuration is retained. Queued start/restart requests cannot revive a host after quit or installation begins.

## Shared clients

A single Vite production build emits Web and desktop bootstrap entries. Business JavaScript, CSS, images, and SVG sprites live in `out/web/assets`; Electron retains `out/renderer/index.html`, its `file:` origin, HashRouter, and preload. Each Web build refreshes desktop HTML references so retired asset hashes cannot strand the desktop entry. Desktop HTML is excluded from the public Web output and precache.

Only the Web entry imports Service Worker registration, installation/update controls, and mobile viewport handling. PWA caches contain static resources; API, authentication, and streaming responses remain live. Text drafts, foreground/network recovery, explicit refresh, and old-tab asset retention remain intact. Public static responses negotiate Brotli or gzip without changing their MIME type or cache policy; small or already compressed resources normally retain their original representation.

The desktop manager stays available while the local Server is stopped or unavailable. Once the business UI has mounted, service loss does not unmount it or discard unsent image state. Reconnection resolves the current native Gateway endpoint again. Native and Web clients never automatically resend commands after an uncertain connection failure.

Terminal disconnect behavior is unchanged: losing the owning WebSocket destroys its PTY. Persistent detach/reattach and output replay are separate features.

## Build and distribution

| Command | Output or behavior |
| --- | --- |
| `bun run build` | Desktop shell, local Server/CLI, and shared production UI |
| `bun run build:web` | `out/web` and the thin `out/renderer/index.html` |
| `bun run build:server-app` | Standalone Server/CLI and Web UI |
| `bun run pack:server` | Relocatable target-platform directory with frozen production dependencies |
| `bun run server:dev` | Foreground Node host with Vite and source watching |
| `bun run server:up` | The same managed development stack in the background |
| `bun run server:restart` | Restart using the calling checkout and environment |

Successful backend rebuilds replace only the owned runtime; a failed build leaves the previous runtime available. Stopping development also closes its watchers and control listener. The legacy `bun run start` entry keeps its separate port, settings/device paths, and authentication behavior.

Server directory packages are built on the target OS and architecture. Native modules and SDK optional dependencies are installed from the frozen lockfile rather than copied from another platform. Packaging prepares node-pty helper executable permissions; desktop bundles explicitly unpack the native dependencies. Existing desktop identity and update configuration remain unchanged. Existing Electron AppImage/deb outputs remain desktop packages.

The runtime boundary does not remove engine SDK payloads: the tested Linux directory was about 1.2 GiB, mostly the existing Claude/Copilot distributions. Compiled Server/Web code was about 17 MiB. These figures do not imply a proportional memory reduction.

See [Server runtime and distribution](server-runtime.md) for launch, paths, service management, and rollback, and [Web and mobile PWA](web-pwa.md) for client behavior.

## Validation

The migration was developed in independently buildable checkpoints, followed by integration of published Desktop sharing. Validation includes:

- Full unit, type, lint, build, and coverage checks, including queued startup, ownership replacement, shutdown failures, settings serialization, and authoritative snapshot persistence.
- A real macOS ARM64 package: ASAR Server/CLI and native module loading, PTY/watcher operations, file-origin shared resources, stopped-server management, start/restart, and clean quit.
- A relocated Linux ARM64 production directory with no Electron/display/source dependency, authenticated HTTP/WebSocket operations, private CLI, PTY/watcher, and service cleanup.
- Old-to-new-to-old package changes against one isolated data directory, preserving JWTs, history, settings, channel/task fixtures, worktree metadata, and persisted-file hashes.
- Actual development source updates, failed builds, stop-during-rebuild, parent IPC loss, stale-lease recovery, and explicit restart environment changes.
- Production UI interaction and screenshots for shared assets, drafts, Settings/Devices, PWA updates across two tabs, old-version cache fallback, and cleanup.
- Read-only live Codex Desktop checks with a dedicated conversation, two synchronized clients, installed shared-engine controls, and catalog/history discovery.

Physical iOS/Android installation and background behavior, Windows native packaging/process cleanup, and every live external engine/channel workflow require separate acceptance evidence. Mock browser or passing build results do not establish those workflows.
