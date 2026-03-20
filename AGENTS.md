# CodeMux - AI Agent Development Guide

## Project Overview

**CodeMux** is a multi-engine AI coding assistant client. It runs as an Electron desktop app (or standalone web server) that connects to multiple AI coding engines — OpenCode, GitHub Copilot, and Claude Code — through a unified WebSocket gateway. Users can access it locally or remotely via Cloudflare Tunnel.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron 40 (`electron: ^40.6.1`) |
| Build System | electron-vite (Vite 5) |
| Frontend | SolidJS 1.8 + TypeScript 5 |
| Styling | Tailwind CSS v4 + CSS Modules |
| Routing | @solidjs/router (HashRouter in Electron, BrowserRouter in web) |
| i18n | @solid-primitives/i18n (en, zh) |
| Markdown | marked 11 + shiki 1.22 (syntax highlighting) |
| Backend Comm | WebSocket (ws) with custom JSON-RPC protocol |
| Packaging | electron-builder (DMG for macOS, NSIS for Windows) |
| Testing | Vitest 4 (unit) + Playwright (e2e) |
| Scripts | Bun |

### Project Structure

```
codemux/
├── electron/
│   ├── main/
│   │   ├── index.ts                  # Main process entry (service orchestration)
│   │   ├── ipc-handlers.ts           # IPC handler registration
│   │   ├── window-manager.ts         # BrowserWindow creation
│   │   ├── engines/                   # Engine adapters
│   │   │   ├── engine-adapter.ts         # Abstract base class
│   │   │   ├── opencode/                 # OpenCode CLI (HTTP REST + SSE)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── server.ts
│   │   │   ├── copilot/                  # GitHub Copilot (@github/copilot-sdk)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── config.ts
│   │   │   ├── claude/                   # Claude Code (@anthropic-ai/claude-agent-sdk)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── cc-session-files.ts
│   │   │   └── mock-adapter.ts           # Mock engine for testing
│   │   ├── gateway/                   # WebSocket Gateway
│   │   │   ├── ws-server.ts              # WebSocket server
│   │   │   └── engine-manager.ts         # Engine routing & lifecycle
│   │   ├── channels/                  # External messaging channels
│   │   │   ├── channel-adapter.ts        # Abstract channel base class
│   │   │   ├── channel-manager.ts        # Channel lifecycle & config persistence
│   │   │   ├── gateway-ws-client.ts      # Internal WS client (channel → gateway)
│   │   │   └── feishu/                   # Feishu (Lark) bot integration
│   │   │       ├── feishu-adapter.ts
│   │   │       ├── feishu-card-builder.ts
│   │   │       ├── feishu-command-parser.ts
│   │   │       ├── feishu-message-formatter.ts
│   │   │       ├── feishu-session-mapper.ts
│   │   │       └── feishu-types.ts
│   │   └── services/                  # Backend services
│   │       ├── auth-api-server.ts        # Auth API (HTTP on :4097, internal)
│   │       ├── device-store.ts           # Authorized devices persistence
│   │       ├── conversation-store.ts     # Session persistence (filesystem)
│   │       ├── update-manager.ts         # Auto-update management
│   │       ├── logger.ts                 # Logger + settings.json read/write
│   │       ├── production-server.ts      # Production HTTP server
│   │       └── tunnel-manager.ts         # Cloudflare Tunnel management
│   └── preload/
│       └── index.ts                  # contextBridge (electronAPI)
├── shared/                            # Code shared between main & renderer
│   ├── auth-route-handlers.ts            # Auth route handling logic
│   ├── device-store-base.ts              # Device store base class
│   ├── device-store-types.ts             # Device store type definitions
│   ├── http-utils.ts                     # HTTP utility functions
│   └── jwt.ts                            # JWT token handling
├── src/                               # SolidJS renderer
│   ├── main.tsx                       # App mount point
│   ├── App.tsx                        # Router setup & i18n provider
│   ├── pages/
│   │   ├── EntryPage.tsx              # Landing page (local auto-auth / remote login)
│   │   ├── Chat.tsx                   # Main chat interface
│   │   ├── Settings.tsx               # Settings page (engines, models, channels)
│   │   └── Devices.tsx                # Device management
│   ├── components/
│   │   ├── SessionSidebar.tsx         # Sidebar: project groups + session list
│   │   ├── SessionTurn.tsx            # Single assistant turn (steps, tool calls)
│   │   ├── MessageList.tsx            # Message rendering
│   │   ├── PromptInput.tsx            # Input area (agent/plan/autopilot modes)
│   │   ├── AddProjectModal.tsx        # Add project dialog
│   │   ├── HideProjectModal.tsx       # Hide project dialog
│   │   ├── FeishuConfigModal.tsx      # Feishu channel config dialog
│   │   ├── ContextGroup.tsx           # Context group display
│   │   ├── InputAreaPermission.tsx    # Permission request in input area
│   │   ├── InputAreaQuestion.tsx      # Question prompt in input area
│   │   ├── TodoDock.tsx               # Todo dock component
│   │   ├── UpdateNotification.tsx     # Auto-update notification
│   │   ├── AccessRequestNotification.tsx  # Remote access approval toast
│   │   ├── Collapsible.tsx            # Expand/collapse wrapper
│   │   ├── LanguageSwitcher.tsx       # Language toggle
│   │   ├── ThemeSwitcher.tsx          # Theme toggle (light/dark/system)
│   │   ├── Spinner.tsx                # Loading indicator
│   │   ├── icons/                     # Custom SVG icon components
│   │   └── share/                     # Content renderers
│   │       ├── part.tsx                   # Part type dispatcher
│   │       ├── content-markdown.tsx       # Markdown (marked + shiki)
│   │       ├── content-code.tsx           # Code file viewer
│   │       ├── content-bash.tsx           # Shell command display
│   │       ├── content-diff.tsx           # Diff viewer
│   │       ├── content-text.tsx           # Plain text
│   │       ├── content-error.tsx          # Error display
│   │       ├── common.tsx                 # Shared utilities
│   │       ├── TextReveal.tsx             # Text reveal animation
│   │       ├── TextShimmer.tsx            # Text shimmer animation
│   │       └── tools/                     # Tool-specific renderers
│   ├── stores/
│   │   ├── session.ts                 # Session & project state
│   │   ├── message.ts                 # Messages & parts state
│   │   └── config.ts                  # Models, engines, engine model selections
│   ├── lib/
│   │   ├── gateway-client.ts          # WebSocket client (auto-reconnect, RPC)
│   │   ├── gateway-api.ts             # High-level gateway API (connects to stores)
│   │   ├── auth.ts                    # Auth helpers (token mgmt, local/remote auth)
│   │   ├── settings.ts                # Unified settings persistence
│   │   ├── i18n.tsx                   # I18n provider & useI18n hook
│   │   ├── theme.ts                   # Theme management
│   │   ├── platform.ts                # Platform detection (Electron/web/remote)
│   │   ├── useAuthGuard.ts            # Route auth guard hook
│   │   ├── electron-api.ts            # Typed electronAPI accessor
│   │   └── logger.ts                  # Configurable logger (VITE_LOG_LEVEL)
│   ├── locales/
│   │   ├── en.ts                      # English translations
│   │   └── zh.ts                      # Chinese translations
│   └── types/
│       ├── unified.ts                 # All shared types + gateway protocol
│       ├── tool-mapping.ts            # Engine-specific → normalized tool names
│       └── electron.d.ts              # ElectronAPI type declarations
├── scripts/                           # Bun scripts (setup, start, update binaries)
├── tests/                             # Unit + E2E tests (Vitest + Playwright)
│   └── unit/                          # Unit tests mirroring source structure
│       ├── electron/                      # Tests for electron/ sources
│       ├── shared/                        # Tests for shared/ sources
│       └── src/                           # Tests for src/ sources
├── electron.vite.config.ts            # Build config (main/preload/renderer)
├── electron-builder.yml               # Packaging config
├── vite.config.ts                     # Standalone Vite dev server config
├── vitest.config.ts                   # Vitest config (tests/unit/**/*.test.ts)
└── package.json
```

---

## Core Architecture

### Communication Flow

```
SolidJS UI
  └─ GatewayAPI (src/lib/gateway-api.ts)           # High-level typed API
      └─ GatewayClient (src/lib/gateway-client.ts)  # WebSocket + RPC
          └─ WebSocket /ws
              └─ GatewayServer (electron/main/gateway/ws-server.ts)
                  └─ EngineManager (electron/main/gateway/engine-manager.ts)
                      ├─ OpenCodeAdapter   → OpenCode CLI (HTTP :4096 + SSE)
                      ├─ CopilotSdkAdapter → @github/copilot-sdk (JSON-RPC/stdio)
                      └─ ClaudeCodeAdapter → @anthropic-ai/claude-agent-sdk (stdio)
```

### Service Ports (Dev Mode)

| Service | Port | Protocol |
|---------|------|----------|
| Vite Dev Server | 5173 | HTTP |
| Gateway WebSocket | 4200 | WS |
| OpenCode Adapter | 4096 | HTTP + SSE |
| Auth API Server | 4097 | HTTP (internal) |

### Engine Types

- **`"opencode"`** — OpenCode CLI, communicates via HTTP REST + SSE streaming
- **`"copilot"`** — GitHub Copilot, uses `@github/copilot-sdk` (spawns Copilot CLI via JSON-RPC/stdio, reads session history from JSONL event files)
- **`"claude"`** — Claude Code, uses `@anthropic-ai/claude-agent-sdk` (spawns Claude CLI via stdio, model list via SDK query)

### Gateway Protocol

JSON messages over WebSocket:

- **Request**: `{ type: "session.list", requestId: "xxx", payload: {...} }`
- **Response**: `{ type: "response", requestId: "xxx", payload: {...}, error?: {...} }`
- **Notification** (push): `{ type: "message.part.updated", payload: {...} }`

Key request types: `engine.list`, `session.create`, `session.list`, `message.send`, `message.cancel`, `model.list`, `model.set`, `mode.get`, `mode.set`, `permission.reply`, `project.list`

---

## State Management

Uses SolidJS `createStore` for reactive state management.

### Session Store (`src/stores/session.ts`)

```typescript
interface SessionInfo {
  id: string;
  engineType: EngineType;
  title: string;
  directory: string;
  projectID?: string;
  createdAt: string;        // ISO time string
  updatedAt: string;
}

// Store shape
{
  list: SessionInfo[];
  current: string | null;
  loading: boolean;
  initError: string | null;
  projects: UnifiedProject[];
  projectExpanded: ProjectExpandState;
}
```

### Message Store (`src/stores/message.ts`)

```typescript
// Store shape
{
  message: { [sessionId: string]: UnifiedMessage[] };  // Messages grouped by session
  part: { [messageId: string]: UnifiedPart[] };         // Parts grouped by message
  permission: { [sessionId: string]: UnifiedPermission[] };
  question: { [sessionId: string]: UnifiedQuestion[] };
  expanded: { [key: string]: boolean };                 // Collapse/expand state
  stepsLoaded: { [messageId: string]: boolean };        // Lazy-load state for steps
}
```

### Config Store (`src/stores/config.ts`)

```typescript
// Store shape
{
  models: ...;
  engines: EngineInfo[];
  currentEngineType: EngineType;
  engineModelSelections: Record<EngineType, { providerID: string; modelID: string }>;
}
```

---

## Unified Type System

All engines share normalized types defined in `src/types/unified.ts`:

- **`UnifiedPart`** discriminated union: `text`, `reasoning`, `file`, `step-start`, `step-finish`, `snapshot`, `patch`, `tool`
- **`ToolPart.normalizedTool`**: `shell`, `read`, `write`, `edit`, `grep`, `glob`, `list`, `web_fetch`, `task`, `todo`, `sql`, `unknown`
- **Tool name mapping** from engine-specific names in `src/types/tool-mapping.ts`

### Engine-Agnostic Frontend (Critical Rule)

**All engine-specific logic MUST live in the adapter layer (`electron/main/engines/`), never in the frontend (`src/`).**

- Adapters normalize engine-specific data (tool names, argument formats, status values, working directories, session metadata) into unified types before emitting to the frontend.
- The frontend renders based solely on unified types (`UnifiedMessage`, `UnifiedPart`, `ToolPart`, `EngineCapabilities`) — it must **never** branch on `engineType`, check `engineMeta` fields, or hardcode engine names.
- Engine behavioral differences are expressed through `EngineCapabilities` flags (e.g., `customModelInput`, `providerModelHierarchy`), not engine name checks.
- Default engine resolution uses `getDefaultEngineType()` from `config.ts`, not hardcoded strings.

---

## Authentication Flow

### Local Access (localhost)

Auto-authenticate via `localAuth()` — no password needed. The frontend detects it is running on localhost and authenticates automatically.

### Remote Access

1. User enters 6-digit access code on `EntryPage.tsx`
2. Device approval flow → JWT token issued
3. Token stored in `localStorage`
4. Subsequent requests include token for verification

### Auth Architecture

- **Electron mode**: Uses IPC for auth operations between renderer and main process
- **Web mode**: Uses HTTP API to auth server on port 4097
- **Shared logic**: `shared/auth-route-handlers.ts` contains route handling reused by both modes
- **Device persistence**: `shared/device-store-base.ts` + `electron/main/services/device-store.ts`
- **JWT handling**: `shared/jwt.ts`

---

## Data Flow

```
User Input (PromptInput)
   ↓
GatewayAPI.sendMessage()
   ↓
GatewayClient (WebSocket RPC) → GatewayServer
   ↓
EngineManager → Engine Adapter → AI Engine
   ↓
WebSocket Notifications ← GatewayServer
   ↓
GatewayAPI event handlers
   ↓
setMessageStore() → Update Reactive Store
   ↓
UI components re-render (SolidJS fine-grained reactivity)
```

---

## Key Component Descriptions

### Chat.tsx (Main Chat Interface)

Core features:

1. **Session Management** — Initialize sessions, switch between sessions, create/delete sessions
2. **Message Handling** — Send messages via gateway, receive real-time updates via WebSocket notifications
3. **Reactive Data** — Uses `createMemo` to compute current session's message list, sorted by time

### SessionSidebar.tsx

- Displays sessions grouped by project
- Project expand/collapse state
- Session CRUD operations
- Relative time display

### MessageList.tsx

- Iterates messages and renders parts for each
- Filters out internal part types (`step-start`, `snapshot`, `patch`, etc.)
- Delegates to `Part` component for type-specific rendering

### Part.tsx and content-\*.tsx

Content renderers for different part types:

- `content-text.tsx`: Plain text
- `content-markdown.tsx`: Markdown content (using marked + shiki)
- `content-code.tsx`: Code file viewer
- `content-diff.tsx`: Code differences
- `content-bash.tsx`: Shell command execution results
- `content-error.tsx`: Error messages
- `share/tools/`: Tool-specific renderers

### PromptInput.tsx

Input area supporting multiple modes (agent/plan/autopilot). Handles message composition and sending.

---

## Channels

External messaging integrations that bridge chat platforms to CodeMux engines.

```
Feishu Bot (webhook)
  └─ FeishuAdapter (electron/main/channels/feishu/)
      └─ GatewayWsClient (channels/gateway-ws-client.ts)
          └─ WebSocket → GatewayServer (same protocol as UI)
```

- `ChannelManager` manages channel lifecycle, config persistence (`.channels/` dir), and IPC handlers
- Each channel adapter extends `ChannelAdapter` base class
- Channels connect to the gateway as internal WS clients, reusing the same protocol as the UI

---

## Settings Persistence

All user preferences are persisted to `%APPDATA%/codemux/settings.json` (via `app.getPath("userData")`).

```
Renderer (src/lib/settings.ts)      Preload (electron/preload)      Main (services/logger.ts)
  _rendererCache (deep-clone)  →  IPC settings:save  →  saveSettings() → fs write
  getSetting() reads cache          (pass-through)       deep merge for object keys
  saveSetting() updates cache
```

- **Read path**: Preload reads `settings.json` synchronously at startup (`ipcRenderer.sendSync`), exposes via `contextBridge`. Renderer deep-clones into `_rendererCache` on first access.
- **Write path**: `saveSetting(key, val)` updates renderer cache immediately, then fires async IPC to main. Main does one-level deep merge for object-valued keys.
- **Web fallback**: `localStorage` with `settings:` prefix.

Settings shape:

```json
{
  "theme": "light | dark | system",
  "locale": "en | zh",
  "logLevel": "error | warn | info | verbose | debug | silly",
  "engineModels": {
    "opencode": { "providerID": "...", "modelID": "..." },
    "claude": { "providerID": "...", "modelID": "..." }
  }
}
```

---

## Internationalization (i18n)

CodeMux supports English and Simplified Chinese using `@solid-primitives/i18n`.

### Usage

```typescript
import { useI18n } from "../lib/i18n";

function MyComponent() {
  const { t, locale, setLocale } = useI18n();
  return <h1>{t().login.title}</h1>;
}
```

For dynamic text with variables:

```typescript
import { useI18n, formatMessage } from "../lib/i18n";

// Translation: "minutesAgo": "{count} minutes ago"
<span>{formatMessage(t().sidebar.minutesAgo, { count: 5 })}</span>
```

### Adding a New Language

1. Create translation file `src/locales/[code].ts` implementing `LocaleDict` interface
2. Register in `src/lib/i18n.tsx` (add to `dictionaries`, `localeNames`, `LocaleCode` type)
3. Add to `LanguageSwitcher.tsx` locales array

### i18n Rules

- **Never hardcode user-facing strings** — always use `t()`
- **Use `formatMessage()` for interpolation** — never concatenate strings
- **Keep all locale files in sync** — when adding keys, update both `en.ts` and `zh.ts`

---

## CSS Conventions

- Tailwind utility classes for layout and common styling
- CSS Modules (`.module.css`) for `share/` components with complex styles
- Dark mode via `.dark` class on `<html>`, toggled by `ThemeSwitcher`
- CSS custom properties for theme colors (`--color-background`, `--color-text`, etc.)

---

## Routes

| Path | Component | Auth Required |
|------|-----------|--------------|
| `/` | EntryPage | No |
| `/chat` | Chat | Yes (redirects to `/` if unauthenticated) |
| `/settings` | Settings | No |
| `/devices` | Devices | No |

---

## Development

### Commands

```bash
# Install dependencies
bun install

# Start dev server (with Electron window)
npm run dev

# Start dev server (web-only, for browser testing)
bun run start

# Type check
npm run typecheck

# Build
npm run build

# Run unit tests
bun run test:unit

# Run all tests (unit + e2e)
bun run test

# Package for distribution
npm run dist:win   # Windows NSIS installer
npm run dist:mac   # macOS DMG
```

### Dev Server Proxy (`electron.vite.config.ts`)

- `/ws` → `http://localhost:4200` (Gateway WebSocket)
- `/opencode-api` → `http://localhost:4096` (OpenCode REST, prefix stripped)
- Auth requests proxied via `createAuthProxyPlugin` to internal auth server

### Web-Only Mode (`bun run start`)

Uses `scripts/start.ts` + `vite.config.ts`:

1. Generates 6-digit random access code
2. Installs OpenCode CLI if needed
3. Starts Vite dev server + OpenCode server concurrently

---

## Common Development Tasks

### Adding a New Message Part Type

1. **Add type** to `UnifiedPart` union in `src/types/unified.ts`
2. **Add rendering** in `src/components/share/part.tsx`
3. **Create renderer** component in `src/components/share/content-*.tsx`

### Adding a New Gateway Request Type

1. **Add handler** in `electron/main/gateway/ws-server.ts`
2. **Add API method** in `src/lib/gateway-api.ts`
3. **Add client method** if needed in `src/lib/gateway-client.ts`

### Adding a New Engine Adapter

1. **Create adapter directory** in `electron/main/engines/[engine-name]/`
2. **Extend** `EngineAdapter` base class from `engine-adapter.ts`
3. **Implement converters** to normalize engine-specific data into unified types
4. **Register** in `EngineManager` (`electron/main/gateway/engine-manager.ts`)

### Adding a New Channel

1. **Create adapter directory** in `electron/main/channels/[channel-name]/`
2. **Extend** `ChannelAdapter` base class from `channel-adapter.ts`
3. **Register** in `ChannelManager` (`electron/main/channels/channel-manager.ts`)

---

## Testing

### Unit Tests

- **Framework**: Vitest 4.0.18
- **Config**: `vitest.config.ts` — `include: ["tests/unit/**/*.test.ts"]`, env: `node`
- **Structure**: `tests/unit/` mirrors source directories (`electron/`, `shared/`, `src/`)
- **Run**: `bun run test:unit`

Test organization rules:

- Top-level dirs under `tests/unit/` must be `electron/`, `shared/`, `src/`
- Each sub-`describe` tests ONE important exported function
- `it` blocks test various scenarios; multiple `expect` per `it` is encouraged
- Use `it.each` for parameterized similar-input variations
- Naming: declarative sentences, no `should`

### E2E Tests

See [docs/e2e-testing.md](docs/e2e-testing.md) for full guide. Uses Playwright with Halo AI Browser for browser automation.

---

## Debugging Tips

### Console Log Prefixes

- `[GW]` / `[Gateway]`: Gateway WebSocket events
- `[Engine]`: Engine adapter events
- `[Init]`: Session initialization
- `[LoadMessages]`: Message loading
- `[SelectSession]`: Session switching

### Common Issue Troubleshooting

#### Messages Not Displaying

1. Verify `createMemo` is used for computed message lists (required for SolidJS reactive tracking)
2. Check if message data is correctly stored in the store
3. Check if `MessageList` filtering logic is filtering out expected messages
4. Check if the message's `parts` array is empty

#### WebSocket Connection Failed

1. Check if Gateway server is running on port 4200
2. Check if Vite proxy configuration is correct in `electron.vite.config.ts`
3. View WebSocket connection status in browser Network panel

#### Engine Not Available

1. Check if the engine CLI is installed and accessible in PATH
2. Check engine adapter logs for startup errors
3. Verify engine-specific ports are not in use (e.g., 4096 for OpenCode)

---

## Code Style Guide

### TypeScript

- Prefer `interface` for object types
- Use `type` for union types
- Avoid `any`, use `unknown` when necessary

### SolidJS

- Use `createSignal` for simple state
- Use `createStore` for complex nested state
- Use `createMemo` to cache computed values (ensures reactive tracking)
- Use `createEffect` for side effects
- Use `Show` component instead of ternary expressions

### Components

- Use function components
- Define Props with `interface`
- Prefer controlled components
- Event handler naming: `handle*` (e.g., `handleClick`)

### File Naming

- Components: PascalCase (e.g., `SessionSidebar.tsx`)
- Utils/Libs: camelCase (e.g., `gateway-client.ts`)
- Types: camelCase (e.g., `unified.ts`)

---

## Common Pitfalls

### 1. Engine-Specific Logic in Frontend

❌ **Wrong**:

```typescript
if (engineType === "copilot") {
  // Special handling for Copilot
}
```

✅ **Correct**:

```typescript
// Use capabilities flags
if (engine.capabilities.customModelInput) {
  // Behavior driven by capability, not engine name
}
```

### 2. Not Using createMemo

❌ **Wrong**:

```typescript
const currentMessages = () => {
  return messageStore.message[sessionId] || [];
};
```

✅ **Correct**:

```typescript
const currentMessages = createMemo(() => {
  return messageStore.message[sessionId] || [];
});
```

### 3. Hardcoded Strings Instead of i18n

❌ **Wrong**:

```typescript
<button>Save Changes</button>
```

✅ **Correct**:

```typescript
const { t } = useI18n();
<button>{t().settings.save}</button>
```

### 4. String Concatenation Instead of formatMessage

❌ **Wrong**:

```typescript
<span>{count + " minutes ago"}</span>
```

✅ **Correct**:

```typescript
<span>{formatMessage(t().sidebar.minutesAgo, { count })}</span>
```

---

## Dependencies

### Core

| Package | Version | Purpose |
|---------|---------|---------|
| `solid-js` | ^1.8.0 | UI framework |
| `@solidjs/router` | ^0.14.10 | Router management |
| `electron` | ^40.6.1 | Desktop shell |
| `ws` | ^8.19.0 | WebSocket communication |

### Engine SDKs

| Package | Version | Purpose |
|---------|---------|---------|
| `@opencode-ai/sdk` | ^1.2.15 | OpenCode integration |
| `@github/copilot-sdk` | ^0.1.26 | Copilot integration |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.63 | Claude Code integration |

### UI & Rendering

| Package | Version | Purpose |
|---------|---------|---------|
| `tailwindcss` | ^4.0.0 | CSS framework |
| `marked` | ^11.1.0 | Markdown parsing |
| `shiki` | ^1.22.0 | Code highlighting |
| `diff` | ^5.1.0 | Code diff display |
| `luxon` | ^3.4.0 | Date/time handling |
| `lang-map` | ^0.4.0 | Language file extension mapping |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| `electron-vite` | ^2.3.0 | Build system |
| `electron-builder` | ^25.1.8 | Packaging |
| `vitest` | ^4.0.18 | Unit testing |
| `@playwright/test` | ^1.58.2 | E2E testing |
| `vite-plugin-solid` | ^2.10.0 | SolidJS Vite plugin |

---

**Last Updated**: 2026-03-10
**Project Version**: 1.3.3
