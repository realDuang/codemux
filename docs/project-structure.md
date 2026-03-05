# Project Structure

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
│   │   │   ├── copilot-sdk-adapter.ts # GitHub Copilot (@github/copilot-sdk)
│   │   │   ├── claude-code-adapter.ts # Claude Code (@anthropic-ai/claude-agent-sdk)
│   │   │   └── mock-adapter.ts       # Mock engine for testing
│   │   ├── gateway/              # WebSocket Gateway
│   │   │   ├── ws-server.ts          # WebSocket server
│   │   │   └── engine-manager.ts     # Engine routing & lifecycle
│   │   ├── channels/             # External messaging channels
│   │   │   ├── channel-adapter.ts    # Abstract channel base class
│   │   │   ├── channel-manager.ts    # Channel lifecycle & config persistence
│   │   │   ├── gateway-ws-client.ts  # Internal WS client (channel → gateway)
│   │   │   └── feishu/               # Feishu (Lark) bot integration
│   │   │       ├── feishu-adapter.ts
│   │   │       ├── feishu-card-builder.ts
│   │   │       ├── feishu-command-parser.ts
│   │   │       ├── feishu-message-formatter.ts
│   │   │       ├── feishu-session-mapper.ts
│   │   │       └── feishu-types.ts
│   │   └── services/             # Backend services
│   │       ├── auth-api-server.ts    # Auth API (token-based)
│   │       ├── device-store.ts       # Authorized devices persistence
│   │       ├── session-store.ts      # Session persistence (filesystem)
│   │       ├── logger.ts             # Logger + settings.json read/write
│   │       ├── production-server.ts  # Production HTTP server
│   │       └── tunnel-manager.ts     # Cloudflare Tunnel management
│   └── preload/
│       └── index.ts              # contextBridge (electronAPI)
├── src/                          # SolidJS renderer
│   ├── main.tsx                  # App mount point
│   ├── App.tsx                   # Router setup & i18n provider
│   ├── pages/
│   │   ├── EntryPage.tsx         # Landing page (local auto-auth / remote login)
│   │   ├── Chat.tsx              # Main chat interface
│   │   ├── Settings.tsx          # Settings page (engines, models, channels)
│   │   └── Devices.tsx           # Device management
│   ├── components/
│   │   ├── SessionSidebar.tsx    # Sidebar: project groups + session list
│   │   ├── SessionTurn.tsx       # Single assistant turn (steps, tool calls)
│   │   ├── MessageList.tsx       # Message rendering
│   │   ├── PromptInput.tsx       # Input area (agent/plan/autopilot modes)
│   │   ├── AddProjectModal.tsx   # Add project dialog
│   │   ├── HideProjectModal.tsx  # Hide project dialog
│   │   ├── FeishuConfigModal.tsx # Feishu channel config dialog
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
│   │       └── common.tsx            # Shared utilities
│   ├── stores/
│   │   ├── session.ts            # Session & project state
│   │   ├── message.ts            # Messages & parts state
│   │   └── config.ts             # Models, engines, engine model selections
│   ├── lib/
│   │   ├── gateway-client.ts     # WebSocket client (auto-reconnect, RPC)
│   │   ├── gateway-api.ts        # High-level gateway API (connects to stores)
│   │   ├── auth.ts               # Auth helpers (token mgmt, local/remote auth)
│   │   ├── settings.ts           # Unified settings persistence (settings.json ↔ renderer)
│   │   ├── i18n.tsx              # I18n provider & useI18n hook
│   │   ├── theme.ts              # Theme management
│   │   ├── platform.ts           # Platform detection (Electron/web/remote)
│   │   ├── project-store.ts      # Project visibility preferences
│   │   ├── useAuthGuard.ts       # Route auth guard hook
│   │   ├── electron-api.ts       # Typed electronAPI accessor
│   │   └── logger.ts             # Configurable logger (VITE_LOG_LEVEL)
│   ├── locales/
│   │   ├── en.ts                 # English translations
│   │   └── zh.ts                 # Chinese translations
│   └── types/
│       ├── unified.ts            # All shared types + gateway protocol
│       ├── tool-mapping.ts       # Engine-specific → normalized tool names
│       └── electron.d.ts         # ElectronAPI type declarations
├── scripts/                      # Bun scripts (setup, start, update binaries)
├── tests/                        # Unit + E2E tests (Vitest + Playwright)
├── electron.vite.config.ts       # Build config (main/preload/renderer)
├── electron-builder.yml          # Packaging config
├── vite.config.ts                # Standalone Vite dev server config
└── package.json
```
