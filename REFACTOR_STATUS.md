# Multi-Engine Gateway Refactor — Status

## Architecture

```
Frontend (SolidJS)
  └─ GatewayClient (WebSocket, auto-reconnect)
       └─ GatewayServer (ws-server.ts, auth, keepalive)
            └─ EngineManager (session→engine routing)
                 ├─ OpenCodeAdapter (ACP over stdio)
                 ├─ CopilotAdapter (ACP over stdio, extends AcpBaseAdapter)
                 └─ ClaudeAdapter (placeholder, disabled)
```

The frontend connects via WebSocket to a Gateway server in Electron's main process. The Gateway routes requests to engine adapters using a unified protocol. Each adapter communicates with its backend (OpenCode, Copilot CLI) over ACP (Agent Communication Protocol) via NDJSON stdio.

## What Was Done

### Phase 1 — Unified Type System (`src/types/unified.ts`)
- `UnifiedSession`, `UnifiedMessage`, `UnifiedPart`, `UnifiedPermission`, `UnifiedProject`
- `ToolState` with `pending` / `running` / `completed` / `error` lifecycle
- `GatewayRequestType` / `GatewayNotificationType` enums
- `NormalizedToolName` type + tool mapping utilities (`src/types/tool-mapping.ts`)
- Deleted old `src/types/opencode.ts`

### Phase 2 — Engine Adapters (`electron/main/engines/`)
- `EngineAdapter` interface: sessions, messages, models, modes, permissions, projects
- `AcpBaseAdapter`: shared ACP logic (JSON-RPC stdio, session/update notifications, message buffering, tool call lifecycle)
- `OpenCodeAdapter` extends `AcpBaseAdapter`: spawns `opcode` binary
- `CopilotAdapter` extends `AcpBaseAdapter`: spawns `copilot` binary with `--acp` flag
- `EngineManager`: multi-engine request routing, `sessionEngineMap` for session→engine binding

### Phase 3 — Gateway WebSocket Server (`electron/main/gateway/`)
- `GatewayServer` (ws-server.ts): auth, request routing, notification broadcasting, 30s keepalive ping
- `GatewayClient` (gateway-client.ts): browser WS client, auto-reconnect with backoff (500/1000/2000/5000ms)
- `GatewayAPI` (gateway-api.ts): typed wrapper for frontend consumption

### Phase 4 — Frontend Migration
- All components migrated from `opencode-client.ts` (deleted) to `gateway-api.ts`
- `Chat.tsx`: session init, error recovery, message/part/permission handling, per-session sending state
- `SessionSidebar.tsx`: engine-separated sidebar with project grouping
- `PromptInput.tsx`: mode selector, model selector, cancel/stop button, per-engine mode list
- `ModelSelector.tsx`: reactive model loading per engine type
- `AddProjectModal.tsx`: engine type selection for new projects
- `Settings.tsx`: engine list display

### Phase 5 — Multi-Engine Session Support
- Per-engine model/mode loading (models and modes loaded per engine type, not globally)
- Engine-separated sidebar (sessions grouped by engine, then by project)
- `currentEngineType` derived from selected session, propagated to ModelSelector/PromptInput
- ACP engines populate modes only after `createSession`; engines refreshed after session creation

## Bug Fixes (Sessions 2-4)

### Session Management
1. **Engine binding in `listSessions()`** — sessions from `listSessions()` were not registered in `sessionEngineMap`, causing subsequent operations to fail
2. **Init failure blank page** — added `initError` state + error recovery UI with Retry button
3. **Missing try-catch in async handlers** — 6 handlers lacked error handling; `handleSendMessage` failure would permanently lock send button
4. **New Copilot session not in sidebar** — `handleNewSession` didn't pass `projectID`; sidebar fallback matching required `projectID` to be truthy

### WebSocket & Communication
5. **Gateway WS keepalive** — 30s server-side ping interval to prevent idle drops
6. **WS reconnect without recovery** — `onConnected` handler auto-retries `initializeSession()` on reconnect
7. **`is-local` API called twice** — static cache in `Auth` class
8. **Null guard on gateway messages** — guard against null msg from JSON.parse

### Copilot Message Flow
9. **User messages not displaying** — `handleMessageUpdated` didn't store `msgInfo.parts` to `messageStore.part`; added parts extraction
10. **Streaming output not showing** — ACP `sendMessage` blocks until `session/prompt` completes; parts arrive before message exists. Fixed by auto-creating placeholder assistant message in `handlePartUpdated`
11. **ACP `listMessages` returns empty** — added in-memory `messageHistory` Map to AcpBaseAdapter
12. **`handleMessageUpdated` overwrites streaming parts** — changed from full overwrite to smart merge (prefer existing streaming parts, only add new ones from final message)

### Model / Mode
13. **ModelSelector hardcoded "opencode"** — added `engineType` prop, reactive loading per engine
14. **ModelId double-prefix** — `${providerID}/${modelID}` where `modelID` already had prefix; fixed to use `modelID` directly
15. **Wrong mode list for Copilot** — `configStore.engines` loaded before `createSession` when ACP modes are empty; `??` doesn't trigger fallback for empty arrays. Fixed by refreshing engines after createSession and explicit length check

### Tool Call Rendering
16. **Tool calls showing 0ms / stuck pending** — `handleToolCall` now records `time.start` at creation; `finalizeMessage` resolves pending/running tools to completed when prompt finishes
17. **"running" status ignored** — `handleToolCallUpdate` now handles intermediate statuses instead of silently discarding
18. **Search tools showing as ERROR** — front-end `Switch/Match` used `originalTool` (ACP title string like "Searching for xxx") for dispatch; changed to `normalizedTool` (short names like "grep", "web_fetch")
19. **`ToolIcon` and rendering mismatches** — all tool icon/rendering dispatch updated to use `normalizedTool` values (`shell`, `web_fetch`, `todo` etc.)

### Cancel / Input
20. **Cancel button not working** — `cancelMessage` sent `session/cancel` but `sendMessage`'s `await sendRequest("session/prompt")` stayed blocked. Added `activePromptIds` tracking; cancel now resolves the pending prompt Promise
21. **Input disabled during generation** — replaced global `disabled` prop with `isGenerating`; textarea always editable, only send is blocked during generation
22. **Per-session sending state** — `sending` changed from global boolean to per-session `sendingMap`; switching sessions doesn't block unrelated session input

### UI / Styling
23. **Engine-separated sidebar** — sessions grouped by engine type with separator labels
24. **Debug logging for unknown ACP notifications** — `handleSessionUpdate` default branch logs unrecognized `sessionUpdate` types

## File Change Summary (from initial refactor commit)

### New Files
| File | Purpose |
|------|---------|
| `electron/main/engines/engine-adapter.ts` | Engine adapter interface |
| `electron/main/engines/acp-base-adapter.ts` | Shared ACP adapter logic (JSON-RPC, message buffering, tool lifecycle) |
| `electron/main/engines/opencode-adapter.ts` | OpenCode ACP adapter |
| `electron/main/engines/copilot-adapter.ts` | Copilot CLI ACP adapter |
| `electron/main/engines/claude-adapter.ts` | Claude adapter (disabled placeholder) |
| `electron/main/gateway/engine-manager.ts` | Multi-engine request router |
| `electron/main/gateway/ws-server.ts` | Gateway WebSocket server |
| `src/lib/gateway-client.ts` | Browser WS client with reconnect |
| `src/lib/gateway-api.ts` | Typed frontend gateway API |
| `src/types/unified.ts` | Unified type system |
| `src/types/tool-mapping.ts` | Tool name normalization utilities |
| `.gitattributes` | LF line ending normalization |

### Deleted Files
| File | Reason |
|------|--------|
| `src/lib/opencode-client.ts` | Replaced by gateway-client + gateway-api |
| `src/types/opencode.ts` | Replaced by unified.ts |
| `electron/main/services/opencode-process.ts` | Replaced by engine adapters |

### Modified Files (Key Changes in This Diff)
| File | Changes |
|------|---------|
| `electron/main/engines/acp-base-adapter.ts` | tool_call time tracking, running status handling, finalizeMessage pending resolution, cancel abort mechanism, message history, debug logging |
| `electron/main/engines/opencode-adapter.ts` | null guards on parts array and handlePartUpdated |
| `src/pages/Chat.tsx` | per-session sending state, placeholder assistant message, parts merge logic, cancel handler, engineType propagation |
| `src/components/share/part.tsx` | Switch/Match uses normalizedTool, ToolIcon supports normalized names, RunningToolCard shows title |
| `src/components/PromptInput.tsx` | isGenerating prop (textarea always editable), stop button, mode fallback fix, engineType pass-through |
| `src/components/ModelSelector.tsx` | engineType prop, reactive model loading |
| `src/components/SessionSidebar.tsx` | engine-separated display, directory fallback matching |
| `src/lib/gateway-client.ts` | null guard on incoming messages |
| `src/types/unified.ts` | ToolState pending with optional time |

## Known Issues / Remaining Work

- [ ] `ClaudeAdapter` is disabled — needs binary discovery and MCP protocol if re-enabled
- [ ] `handleRenameSession` only updates local state (no `session.update` in gateway protocol)
- [ ] No connection status indicator in the UI
- [ ] ACP message history is in-memory only — lost on engine restart
- [ ] Tool call `inferToolFromAcp` relies on title heuristics — may misclassify unknown ACP tools
