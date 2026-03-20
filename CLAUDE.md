# CodeMux

Multi-engine AI coding assistant client. Access OpenCode, GitHub Copilot, and Claude Code from any device via Electron native app or browser (with Cloudflare Tunnel for public access).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron 40 (`electron: ^40.6.1`) |
| Build System | electron-vite (Vite 5) |
| Frontend | SolidJS 1.8 + TypeScript 5 |
| Styling | Tailwind CSS v4 + CSS Modules |
| Routing | @solidjs/router (HashRouter in Electron, BrowserRouter in web) |
| i18n | @solid-primitives/i18n (en, zh) |
| Markdown | marked + shiki (syntax highlighting) |
| Backend Comm | WebSocket (ws) with custom JSON RPC protocol |
| Packaging | electron-builder (DMG for macOS, NSIS for Windows) |
| Scripts | Bun |

## Project Structure

See [docs/project-structure.md](docs/project-structure.md) for full annotated file tree.

Key directories:
- `electron/main/engines/` — Engine adapters (OpenCode, Copilot, Claude Code, Mock)
- `electron/main/gateway/` — WebSocket gateway server + engine manager
- `electron/main/channels/` — External messaging channels (Feishu)
- `electron/main/services/` — Auth, device store, logger/settings, tunnel
- `src/pages/` — Route pages (Entry, Chat, Settings, Devices)
- `src/components/` — UI components + `share/` content renderers
- `src/stores/` — SolidJS reactive stores (session, message, config)
- `src/lib/` — Shared utilities (gateway client, auth, settings, i18n, theme)

## Architecture

### Communication Flow

```
SolidJS UI
  └─ GatewayAPI (src/lib/gateway-api.ts)        # High-level typed API
      └─ GatewayClient (src/lib/gateway-client.ts)  # WebSocket + RPC
          └─ WebSocket /ws
              └─ GatewayServer (electron/main/gateway/ws-server.ts)
                  └─ EngineManager (electron/main/gateway/engine-manager.ts)
                      ├─ OpenCodeAdapter → OpenCode CLI (HTTP :4096 + SSE)
                      ├─ CopilotSdkAdapter → @github/copilot-sdk (JSON-RPC/stdio)
                      └─ ClaudeCodeAdapter → @anthropic-ai/claude-agent-sdk (stdio)
```

### Service Ports (Dev Mode)

| Service | Port | Protocol |
|---------|------|----------|
| Vite Dev Server | 5173 | HTTP |
| Gateway WebSocket | 4200 | WS |
| OpenCode Adapter | 4096 | HTTP + SSE |
| Auth API Server | 4097 | HTTP |

### Gateway Protocol

JSON messages over WebSocket:
- **Request**: `{ type: "session.list", requestId: "xxx", payload: {...} }`
- **Response**: `{ type: "response", requestId: "xxx", payload: {...}, error?: {...} }`
- **Notification** (push): `{ type: "message.part.updated", payload: {...} }`

Key request types: `engine.list`, `session.create`, `session.list`, `message.send`, `message.cancel`, `model.list`, `model.set`, `mode.get`, `mode.set`, `permission.reply`, `project.list`

### State Management

SolidJS `createStore` (from `solid-js/store`):

| Store | Key Fields | File |
|-------|-----------|------|
| sessionStore | `list`, `current`, `projects`, `loading` | `src/stores/session.ts` |
| messageStore | `message[sessionId]`, `part[messageId]`, `expanded[key]` | `src/stores/message.ts` |
| configStore | `models`, `engines`, `currentEngineType`, `engineModelSelections` | `src/stores/config.ts` |

### Auth Flow

- **Local access** (localhost): Auto-authenticate via `localAuth()` — no password needed
- **Remote access**: 6-digit access code → device approval flow → JWT token in localStorage
- **Electron**: Uses IPC for auth operations
- **Browser**: Uses HTTP API to auth server

### Engine Types

- `"opencode"` — OpenCode CLI, communicates via HTTP REST + SSE streaming
- `"copilot"` — GitHub Copilot, uses `@github/copilot-sdk` (spawns Copilot CLI via JSON-RPC/stdio, reads session history from JSONL event files)
- `"claude"` — Claude Code, uses `@anthropic-ai/claude-agent-sdk` (spawns Claude CLI via stdio, model list via SDK query)

### Unified Type System

All engines share normalized types defined in `src/types/unified.ts`:
- `UnifiedPart` discriminated union: `text`, `reasoning`, `file`, `step-start`, `step-finish`, `snapshot`, `patch`, `tool`
- `ToolPart.normalizedTool`: `shell`, `read`, `write`, `edit`, `grep`, `glob`, `list`, `web_fetch`, `task`, `todo`, `sql`, `unknown`
- Tool name mapping from engine-specific names in `src/types/tool-mapping.ts`

### Multimodal (Image Attachments)

All engines support image attachments via a unified pipeline:

- **Frontend**: `PromptInput.tsx` handles file picker, drag & drop, and clipboard paste. Images are read as base64 via `FileReader`, stored as `ImageAttachment` objects (id, name, mimeType, data, size). Constraints: JPEG/PNG/GIF/WebP, max 3MB per image, max 4 per message.
- **Unified types**: `MessagePromptContent` carries `{ type: "image", data, mimeType }` alongside text content. `FilePart` renders images in chat. `EngineCapabilities.imageAttachment` flag indicates engine support.
- **Gateway**: WebSocket max payload is 20MB to accommodate base64-encoded images. Images flow as `MessagePromptContent[]` through the same `message.send` request type.
- **Engine adapters**:
  - **OpenCode**: Converts to `FilePartInput` with `data:` URLs
  - **Claude**: Builds Anthropic multimodal content blocks (`source.type: "base64"`)
  - **Copilot**: Decodes base64 to temp files, passes file paths via `attachments`, cleans up after 5s
- **Rendering**: `part.tsx` renders `FilePart` with `<img>` tags using data URLs and `loading="lazy"`

### Routes

| Path | Component | Auth Required |
|------|-----------|--------------|
| `/` | EntryPage | No |
| `/chat` | Chat | Yes (redirects to `/` if unauthenticated) |
| `/settings` | Settings | No |
| `/devices` | Devices | No |

### Engine-Agnostic Frontend (Critical Rule)

**All engine-specific logic MUST live in the adapter layer (`electron/main/engines/`), never in the frontend (`src/`).**

- Adapters normalize engine-specific data (tool names, argument formats, status values, working directories, session metadata) into unified types before emitting to the frontend.
- The frontend renders based solely on unified types (`UnifiedMessage`, `UnifiedPart`, `ToolPart`, `EngineCapabilities`) — it must **never** branch on `engineType`, check `engineMeta` fields, or hardcode engine names.
- Engine behavioral differences are expressed through `EngineCapabilities` flags (e.g. `customModelInput`, `providerModelHierarchy`), not engine name checks.
- Default engine resolution uses `getDefaultEngineType()` from `config.ts`, not hardcoded strings.
- Example: Copilot's `sql` tool operating on the `todos` table is intercepted and converted to a synthetic `normalizedTool: "todo"` part by the adapter — the frontend sees the same todo format as OpenCode/Claude.

## Development

```bash
# Install dependencies
bun install

# Start dev server (with Electron window)
npm run dev

# Start dev server (web-only, for browser testing)
# Uses vite.config.ts with full API middleware
bun run start

# Type check
npm run typecheck

# Build
npm run build

# Package for distribution
npm run dist:win   # Windows NSIS installer
npm run dist:mac   # macOS DMG
```

### Dev Server Proxy (electron.vite.config.ts)

- `/ws` → `http://localhost:4200` (Gateway WebSocket)
- `/opencode-api` → `http://localhost:4096` (OpenCode REST, prefix stripped)

### CSS Conventions

- Tailwind utility classes for layout and common styling
- CSS Modules (`.module.css`) for share/ components with complex styles
- Dark mode via `.dark` class on `<html>`, toggled by ThemeSwitcher
- CSS custom properties for theme colors (`--color-background`, `--color-text`, etc.)

### i18n

- Two locales: `en` (default), `zh`
- Persisted in `settings.json` (key: `locale`)
- Dictionary files: `src/locales/en.ts`, `src/locales/zh.ts`
- Usage: `const t = useI18n(); t().chat.sendMessage`

### Settings Persistence

All user preferences are persisted to `%APPDATA%/codemux/settings.json` (via `app.getPath("userData")`).

```
Renderer (src/lib/settings.ts)      Preload (electron/preload)      Main (services/logger.ts)
  _rendererCache (deep-clone)  →  IPC settings:save  →  saveSettings() → fs write
  getSetting() reads cache          (pass-through)       deep merge for object keys
  saveSetting() updates cache
```

- **Read path**: Preload reads `settings.json` synchronously at startup (`ipcRenderer.sendSync`), exposes via `contextBridge`. Renderer deep-clones into its own `_rendererCache` on first access.
- **Write path**: `saveSetting(key, val)` updates renderer cache immediately, then fires async IPC to main. Main does one-level deep merge for object-valued keys (e.g. `engineModels`) and atomic file write.
- **Web fallback**: `localStorage` with `settings:` prefix.

Settings shape:
```json
{
  "theme": "light" | "dark" | "system",
  "locale": "en" | "zh",
  "logLevel": "error" | "warn" | "info" | "verbose" | "debug" | "silly",
  "engineModels": {
    "opencode": { "providerID": "...", "modelID": "..." },
    "claude": { "providerID": "...", "modelID": "..." }
  }
}
```

### Channels

External messaging integrations that bridge chat platforms to CodeMux engines.

```
Feishu Bot (webhook)
  └─ FeishuAdapter (electron/main/channels/feishu/)
      └─ GatewayWsClient (channels/gateway-ws-client.ts)
          └─ WebSocket → GatewayServer (same as UI)
```

- `ChannelManager` manages channel lifecycle, config persistence (`.channels/` dir), and IPC handlers
- Each channel adapter extends `ChannelAdapter` base class
- Channels connect to the gateway as internal WS clients, reusing the same protocol as the UI

## E2E Browser Testing (via Halo AI Browser)

See [docs/e2e-testing.md](docs/e2e-testing.md) for full guide with code examples.

Key points:
- Must unset `ELECTRON_RUN_AS_NODE` when starting dev server
- `browser_evaluate` MUST pass `args` (otherwise returns `{}`)
- `browser_click` does NOT work on SolidJS elements — use `dispatchEvent` instead
- `browser_snapshot` is the primary inspection method (`browser_screenshot` often times out)
