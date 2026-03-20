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
│   │   │   ├── opencode/             # OpenCode CLI (HTTP REST + SSE)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── server.ts
│   │   │   ├── copilot/              # GitHub Copilot (@github/copilot-sdk)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── config.ts
│   │   │   ├── claude/               # Claude Code (@anthropic-ai/claude-agent-sdk)
│   │   │   │   ├── index.ts
│   │   │   │   ├── converters.ts
│   │   │   │   └── cc-session-files.ts
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
│   │       ├── auth-api-server.ts    # Auth API (HTTP on :4097, internal)
│   │       ├── device-store.ts       # Authorized devices persistence
│   │       ├── conversation-store.ts # Session persistence (filesystem)
│   │       ├── update-manager.ts     # Auto-update management
│   │       ├── logger.ts             # Logger + settings.json read/write
│   │       ├── production-server.ts  # Production HTTP server
│   │       └── tunnel-manager.ts     # Cloudflare Tunnel management
│   └── preload/
│       └── index.ts              # contextBridge (electronAPI)
├── shared/                            # Code shared between main & renderer
│   ├── auth-route-handlers.ts            # Auth route handling logic
│   ├── device-store-base.ts              # Device store base class
│   ├── device-store-types.ts             # Device store type definitions
│   ├── http-utils.ts                     # HTTP utility functions
│   └── jwt.ts                            # JWT token handling
├── src/                               # SolidJS renderer
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
│   │   ├── ContextGroup.tsx     # Context group display
│   │   ├── InputAreaPermission.tsx  # Permission request in input area
│   │   ├── InputAreaQuestion.tsx    # Question prompt in input area
│   │   ├── TodoDock.tsx         # Todo dock component
│   │   ├── UpdateNotification.tsx   # Auto-update notification
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
│   │       ├── common.tsx            # Shared utilities
│   │       ├── TextReveal.tsx        # Text reveal animation
│   │       ├── TextShimmer.tsx       # Text shimmer animation
│   │       └── tools/               # Tool-specific renderers
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
│   └── unit/                     # Unit tests mirroring source structure
│       ├── electron/                 # Tests for electron/ sources
│       ├── shared/                   # Tests for shared/ sources
│       └── src/                      # Tests for src/ sources
├── electron.vite.config.ts       # Build config (main/preload/renderer)
├── electron-builder.yml          # Packaging config
├── vite.config.ts                # Standalone Vite dev server config
├── vitest.config.ts              # Vitest config (tests/unit/**/*.test.ts)
└── package.json
```
