# CodeMux

Remote desktop app and web interface for AI coding assistance. Access OpenCode/Copilot from any device via Electron native app or browser (with Cloudflare Tunnel for public access).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron 33 |
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

```
.
├── electron/
│   ├── main/
│   │   ├── index.ts              # Main process entry (service orchestration)
│   │   ├── ipc-handlers.ts       # IPC handler registration
│   │   ├── window-manager.ts     # BrowserWindow creation
│   │   ├── engines/              # Engine adapters
│   │   │   ├── engine-adapter.ts     # Abstract base class
│   │   │   ├── opencode-adapter.ts   # OpenCode CLI (HTTP REST + SSE)
│   │   │   └── copilot-sdk-adapter.ts # GitHub Copilot (@github/copilot-sdk)
│   │   ├── gateway/              # WebSocket Gateway
│   │   │   ├── ws-server.ts          # WebSocket server
│   │   │   └── engine-manager.ts     # Engine routing & lifecycle
│   │   └── services/             # Backend services
│   │       ├── auth-server.ts        # Auth API (token-based)
│   │       ├── device-store.ts       # Authorized devices persistence
│   │       ├── session-store.ts      # Session persistence (filesystem)
│   │       ├── prod-server.ts        # Production HTTP server
│   │       └── tunnel-manager.ts     # Cloudflare Tunnel management
│   └── preload/
│       └── index.ts              # contextBridge (electronAPI)
├── src/                          # SolidJS renderer
│   ├── main.tsx                  # App mount point
│   ├── App.tsx                   # Router setup & i18n provider
│   ├── pages/
│   │   ├── EntryPage.tsx         # Landing page (local auto-auth / remote login)
│   │   ├── Chat.tsx              # Main chat interface
│   │   ├── Settings.tsx          # Settings page
│   │   └── Devices.tsx           # Device management
│   ├── components/
│   │   ├── SessionSidebar.tsx    # Sidebar: project groups + session list
│   │   ├── SessionTurn.tsx       # Single assistant turn (steps, tool calls)
│   │   ├── MessageList.tsx       # Message rendering
│   │   ├── PromptInput.tsx       # Input area (agent/plan/autopilot modes)
│   │   ├── ModelSelector.tsx     # Model dropdown
│   │   ├── AddProjectModal.tsx   # Add project dialog
│   │   ├── HideProjectModal.tsx  # Hide project dialog
│   │   ├── Collapsible.tsx       # Expand/collapse wrapper
│   │   ├── AccessRequestNotification.tsx  # Remote access approval toast
│   │   ├── LanguageSwitcher.tsx  # Language toggle
│   │   ├── ThemeSwitcher.tsx     # Theme toggle (light/dark/system)
│   │   ├── Spinner.tsx           # Loading indicator
│   │   ├── icons/                # Custom SVG icon components
│   │   └── share/                # Content renderers
│   │       ├── part.tsx              # Part type dispatcher
│   │       ├── content-markdown.tsx  # Markdown (marked + shiki)
│   │       ├── content-code.tsx      # Code file viewer
│   │       ├── content-bash.tsx      # Shell command display
│   │       ├── content-diff.tsx      # Diff viewer
│   │       ├── content-text.tsx      # Plain text
│   │       ├── content-error.tsx     # Error display
│   │       ├── copy-button.tsx       # Copy to clipboard
│   │       └── common.tsx            # Shared utilities
│   ├── stores/
│   │   ├── session.ts            # Session & project state
│   │   ├── message.ts            # Messages & parts state
│   │   └── config.ts             # Models, engines, provider config
│   ├── lib/
│   │   ├── gateway-client.ts     # WebSocket client (auto-reconnect, RPC)
│   │   ├── gateway-api.ts        # High-level gateway API (connects to stores)
│   │   ├── auth.ts               # Auth helpers (token mgmt, local/remote auth)
│   │   ├── i18n.tsx              # I18n provider & useI18n hook
│   │   ├── theme.ts              # Theme management
│   │   ├── platform.ts           # Platform detection (Electron/web/remote)
│   │   ├── project-store.ts      # localStorage project preferences
│   │   └── logger.ts             # Configurable logger (VITE_LOG_LEVEL)
│   ├── locales/
│   │   ├── en.ts                 # English translations
│   │   └── zh.ts                 # Chinese translations
│   └── types/
│       ├── unified.ts            # All shared types + gateway protocol
│       └── tool-mapping.ts       # Engine-specific → normalized tool names
├── opencode/                     # Git submodule: OpenCode CLI source
├── scripts/                      # Bun scripts (setup, start, update binaries)
├── electron.vite.config.ts       # Build config (main/preload/renderer)
├── electron-builder.yml          # Packaging config
├── vite.config.ts                # Standalone Vite dev server config
└── package.json
```

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
                      └─ CopilotSdkAdapter → @github/copilot-sdk (JSON-RPC/stdio)
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
| configStore | `models`, `engines`, `currentEngineType`, `currentModelID` | `src/stores/config.ts` |

### Auth Flow

- **Local access** (localhost): Auto-authenticate via `localAuth()` — no password needed
- **Remote access**: 6-digit access code → device approval flow → JWT token in localStorage
- **Electron**: Uses IPC for auth operations
- **Browser**: Uses HTTP API to auth server

### Engine Types

- `"opencode"` — OpenCode CLI, communicates via HTTP REST + SSE streaming
- `"copilot"` — GitHub Copilot, uses `@github/copilot-sdk` (spawns Copilot CLI via JSON-RPC/stdio, reads session history from JSONL event files)
- `"claude"` — Claude Code (placeholder, not yet implemented)

### Unified Type System

All engines share normalized types defined in `src/types/unified.ts`:
- `UnifiedPart` discriminated union: `text`, `reasoning`, `file`, `step-start`, `step-finish`, `snapshot`, `patch`, `tool`
- `ToolPart.normalizedTool`: `shell`, `read`, `write`, `edit`, `grep`, `glob`, `list`, `web_fetch`, `task`, `todo`, `sql`, `unknown`
- Tool name mapping from engine-specific names in `src/types/tool-mapping.ts`

### Routes

| Path | Component | Auth Required |
|------|-----------|--------------|
| `/` | EntryPage | No |
| `/chat` | Chat | Yes (redirects to `/` if unauthenticated) |
| `/settings` | Settings | No |
| `/devices` | Devices | No |

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
- Stored in `localStorage.locale`
- Dictionary files: `src/locales/en.ts`, `src/locales/zh.ts`
- Usage: `const t = useI18n(); t().chat.sendMessage`

## E2E Browser Testing (via Halo AI Browser)

This section documents the complete methodology for autonomous end-to-end testing of the app through Halo's embedded AI Browser.

### Starting the Dev Server

```bash
# CRITICAL: Must unset ELECTRON_RUN_AS_NODE (inherited from Halo, breaks Electron)
# Setting it to empty string does NOT work — Electron checks for existence, not value.
# Use env -u to truly remove the variable from the child process environment.
env -u ELECTRON_RUN_AS_NODE npx electron-vite dev
```

Run with `run_in_background: true`. Wait for all services (5173, 4200, 4096, 4097).

### browser_evaluate: MUST Pass args

Without `args`, code does NOT execute in page context (always returns `{}`):

```javascript
// WRONG
browser_evaluate({ function: `() => document.title` })

// CORRECT — pass root element as dummy arg
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => document.title`
})
```

### Clicking SolidJS Elements: Use dispatchEvent

SolidJS event delegation stores handlers as `element.$$click` on elements, with a single listener on `document` (bubble phase). Neither `browser_click` nor direct `$$click()` calls work reliably.

**Use `dispatchEvent` — it goes through normal DOM bubbling and is consistently reliable:**

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.trim() === 'TARGET_TEXT') {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          if (el.tagName === 'BUTTON' || el.tagName === 'DIV') {
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, composed: true
            }));
            return "clicked";
          }
          el = el.parentElement;
        }
      }
    }
    return "not found";
  }`
})
```

### Sending Messages

1. Use `browser_fill` on the textarea (triggers SolidJS `onInput` signal)
2. Call textarea's `$$keydown` handler with Enter:

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    const ta = document.querySelector('textarea');
    ta.focus();
    const handler = ta.$$keydown;
    const data = ta.$$keydownData;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    });
    data !== undefined ? handler.call(ta, data, event) : handler.call(ta, event);
    return "sent";
  }`
})
```

### Filling Input Fields (in dialogs, etc.)

```javascript
// Use native setter + dispatchEvent to trigger SolidJS signals
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(input, 'value');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### Handling window.confirm Dialogs

Delete session uses `window.confirm()` which blocks JavaScript execution and causes
`browser_evaluate` to time out. Override it before triggering delete:

```javascript
browser_evaluate({
  args: [{ uid: "snap_xx_0" }],
  function: `(root) => {
    window.confirm = () => true;
    // Now safe to click delete buttons
    const btn = document.querySelector('button[title="Delete session"]');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return "deleted";
  }`
})
```

### Interaction Method Matrix

| Operation | Method |
|-----------|--------|
| Navigate to app | `browser_navigate` → dispatchEvent on "Enter Chat" button |
| Switch session | dispatchEvent click on sidebar `div.cursor-pointer` |
| New session | dispatchEvent click on `button[title="New session"]` (index by project) |
| Send message | `browser_fill` + `$$keydown` Enter on textarea |
| Expand steps | dispatchEvent click on `._stepsTriggerButton_*` |
| Expand tool detail | dispatchEvent click on tool call button inside steps |
| Add project | dispatchEvent click "Add Project" → fill dialog → confirm |
| Delete session | Override `window.confirm = () => true` first, then dispatchEvent click on `button[title="Delete session"]` |
| Delete/hide project | dispatchEvent click on `button[title="Hide Project"]` → confirm in HideProjectModal dialog |

### AI Browser Limitations

| Feature | Status |
|---------|--------|
| `browser_fill` | Works, triggers SolidJS onInput |
| `browser_press_key` | Works for real keyboard events |
| `browser_evaluate` (with args) | Works in page context |
| `browser_evaluate` (no args) | Does NOT execute on page |
| `browser_click` on SolidJS elements | Does NOT trigger delegated events |
| `browser_screenshot` | Often times out |
| `browser_snapshot` | Works, primary inspection method |

### SolidJS Event Delegation

- Delegated events: click, dblclick, input, keydown, keyup, mousedown, mouseup, pointerdown, pointerup, touchstart, touchend, etc.
- Handler storage: `element.$$click`, `element.$$clickData`, `element.$$keydown`, `element.$$input`
- Listener on `document` (bubble phase) via `delegateEvents()`
- Events MUST have `bubbles: true` to reach the document listener
- Disabled elements are skipped
