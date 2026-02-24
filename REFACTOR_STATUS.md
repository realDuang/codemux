# Multi-Engine Gateway Refactor — Status

## Overview

Refactored the architecture from a single OpenCode direct-API client to a **multi-engine gateway** pattern:

```
Frontend (SolidJS)
  └─ GatewayClient (WebSocket)
       └─ GatewayServer (ws-server.ts)
            └─ EngineManager
                 ├─ OpenCodeAdapter (ACP over stdio)
                 └─ ClaudeAdapter (disabled, placeholder)
```

**Key change**: The frontend no longer talks to OpenCode's HTTP API directly. Instead, it connects via WebSocket to a Gateway server running in Electron's main process. The Gateway routes requests to engine adapters using a unified protocol.

## What Was Done

### Phase 1 — Unified Type System (`src/types/unified.ts`)
- Defined `UnifiedSession`, `UnifiedMessage`, `UnifiedPart`, `UnifiedPermission`, `UnifiedProject`, etc.
- Gateway request/response/notification types with `GatewayRequestType` and `GatewayNotificationType` enums.
- Deleted the old `src/types/opencode.ts`.

### Phase 2 — Engine Adapters (`electron/main/engines/`)
- `EngineAdapter` interface with full lifecycle: sessions, messages, models, modes, permissions, projects.
- `OpenCodeAdapter`: spawns `opcode` binary, communicates via ACP (Agent Communication Protocol) over NDJSON stdio.
- `ClaudeAdapter`: placeholder, currently disabled.
- `EngineManager`: routes requests to the correct adapter, maintains `sessionEngineMap` for session→engine routing.

### Phase 3 — Gateway WebSocket Server (`electron/main/gateway/`)
- `GatewayServer` (ws-server.ts): WebSocket server with auth support, request routing, notification broadcasting.
- Server-side ping every 30s to keep connections alive through proxies.
- `GatewayClient` (src/lib/gateway-client.ts): browser-side WS client with auto-reconnect (backoff: 500/1000/2000/5000ms).
- `GatewayAPI` (src/lib/gateway-api.ts): typed wrapper over GatewayClient for the frontend.

### Phase 4 — Frontend Migration
- All components migrated from `opencode-client.ts` (deleted) to `gateway-api.ts`.
- `Chat.tsx`: Full rewrite of session init, message handling, project management.
- `Settings.tsx`: Engine list display, connection status.
- `SessionSidebar.tsx`: Project grouping with expand/collapse.
- `PromptInput.tsx`: Model selector, mode selector, agent mode switching.
- `ModelSelector.tsx`: Unified model display.
- `AddProjectModal.tsx`: Engine type selection.

### Phase 5 — Electron Main Process
- `index.ts`: Parallel engine startup, Gateway server initialization.
- IPC handlers updated for gateway port retrieval.
- Vite dev server proxy: `/ws` → `localhost:4200`.
- ACP exit handler for clean shutdown.

### Bug Fixes (This Session)
1. **Engine binding in `listSessions()`** — sessions returned by `listSessions()` were not registered in `sessionEngineMap`, causing all subsequent operations (listMessages, sendMessage, etc.) to fail with `No engine binding found`.
2. **Init failure blank page** — when `initializeSession` failed, the page showed nothing (loading=false, current=null). Added `initError` state + error recovery UI with Retry button.
3. **Missing try-catch in 6 async handlers** — `loadSessionMessages`, `handleNewSession`, `handleDeleteSession`, `handleHideProject`, `handleAddProject`, `handleSendMessage` all lacked error handling. Notably, `handleSendMessage` failure would permanently lock the send button (`sending` state stuck at true).
4. **Gateway WS keepalive** — no ping/pong mechanism caused idle connections to be dropped by Vite proxy or network intermediaries. Added 30s server-side ping interval.
5. **WS reconnect without recovery** — after WS reconnected, the frontend didn't re-initialize. Added `onConnected` handler that auto-retries `initializeSession()` when in error state.
6. **`is-local` API called twice** — `Chat.tsx` and `AccessRequestNotification.tsx` both called `Auth.isLocalAccess()` on mount. Added static cache in `Auth` class.

## Known Issues / Remaining Work

### Requires Electron Restart to Verify
All main-process changes (`engine-manager.ts`, `ws-server.ts`) require Electron restart. The following could not be E2E tested remotely:

- [ ] **Session creation** — `createSession` via Gateway → OpenCodeAdapter → ACP
- [ ] **Message send/receive** — full round-trip through Gateway WS
- [ ] **Session selection** — loading messages for existing sessions (engine binding fix)
- [ ] **Session delete** — Gateway → adapter → ACP
- [ ] **Add Project flow** — create session in directory, refresh project list
- [ ] **Model/mode switching** — `setModel`, `setMode` via Gateway

### Browser Automation Limitation
- SolidJS event delegation is incompatible with `browser_click` automation. Clicks on buttons succeed (element found) but SolidJS `onClick` handlers don't fire because SolidJS delegates events to the document root.
- Workaround: Direct URL navigation works; `browser_evaluate` returns `{}` for all evaluations.

### Code Quality Items
- [ ] `handleRenameSession` has a TODO: need `session.update` in the gateway protocol (currently only updates local state).
- [ ] `handleSendMessage` shows a temp user message optimistically but doesn't remove it if send fails.
- [ ] No connection status indicator in the UI (user doesn't know if WS is connected/disconnected).
- [ ] `ClaudeAdapter` is disabled — needs Claude binary discovery and MCP protocol implementation if re-enabled.

### Minor
- [ ] CRLF/LF line ending inconsistency in some files (Windows development).
- [ ] `__test_snap*.txt` and `acp-probe-logs/` should be gitignored.

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `electron/main/engines/engine-adapter.ts` | Engine adapter interface |
| `electron/main/engines/opencode-adapter.ts` | OpenCode ACP adapter |
| `electron/main/engines/claude-adapter.ts` | Claude adapter (disabled) |
| `electron/main/gateway/engine-manager.ts` | Multi-engine request router |
| `electron/main/gateway/ws-server.ts` | Gateway WebSocket server |
| `src/lib/gateway-client.ts` | Browser WS client with reconnect |
| `src/lib/gateway-api.ts` | Typed frontend gateway API |
| `src/types/unified.ts` | Unified type system |
| `src/types/tool-mapping.ts` | Tool name mapping utilities |

### Deleted Files
| File | Reason |
|------|--------|
| `src/lib/opencode-client.ts` | Replaced by gateway-client + gateway-api |
| `src/types/opencode.ts` | Replaced by unified.ts |
| `electron/main/services/opencode-process.ts` | Replaced by engine adapters |

### Modified Files (Key)
| File | Changes |
|------|---------|
| `src/pages/Chat.tsx` | Full rewrite: gateway init, error recovery UI, all handlers with try-catch |
| `src/pages/Settings.tsx` | Engine list, connection status display |
| `src/stores/session.ts` | Added `initError`, `projects`, `projectExpanded` |
| `src/stores/config.ts` | Added `engines`, `currentEngineType` |
| `electron/main/index.ts` | Parallel engine startup, gateway init |
| `electron.vite.config.ts` | WS proxy `/ws` → localhost:4200 |
