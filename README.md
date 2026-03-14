<div align="center">

# CodeMux

**[English](./README.md)** | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md)

**The First Open-Source GUI for GitHub Copilot CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*A multi-engine AI coding client with full agent chain-of-thought visualization and zero-config secure remote access — not another chat wrapper.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - Multi-Engine AI Coding Interface" width="800" />

</div>

---

## Why CodeMux?

### 1. First GUI for GitHub Copilot CLI

GitHub Copilot is the most widely adopted AI coding tool in the world. **Copilot CLI** brings its full agentic capabilities to the terminal — but there's no graphical interface for it.

**CodeMux is the first — and currently only — open-source GUI for Copilot CLI.** It connects at the protocol level (JSON-RPC over stdio), giving you Copilot's complete agentic coding experience in a visual interface.

### 2. Multi-Engine, Not Multi-Model

This is not a chat wrapper that swaps API keys. CodeMux is a **protocol-level gateway** — each engine runs with its own runtime, sessions, tool execution, and capabilities fully preserved.

Switch between engines from a single interface. Each keeps its full power — file editing, shell access, session history, project context — CodeMux just gives them a shared front door.

| Engine | Protocol | Status |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ Stable |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | JSON-RPC/stdio | ✅ Stable |
| **[Claude Code](https://claude.ai/code)** | SDK (stdio) | ✅ Stable |

### 3. Agent Chain-of-Thought Visualization

Every agent action is rendered as an expandable step — file diffs, shell commands, search results, tool calls — so you can see exactly what the agent is doing and why, not just the final answer.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - Step-by-Step Agent Visualization" width="700" />

### 4. Zero-Config Secure Remote Access

Access your coding agents from any device — phone, tablet, or another machine — without touching a single config file.

- **LAN**: Auto-detected IP + QR code, ready in seconds
- **Public Internet**: One-click [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — no port forwarding, no VPN, no firewall changes
- **Security built-in**: Device authorization, JWT tokens, HTTPS via Cloudflare, ephemeral tunnel URLs that rotate on every restart

### 5. IM Bot Channels

Use your AI coding agents directly from your favorite messaging apps — no browser needed. CodeMux connects as a bot on each platform, bridging chat messages to any engine through the gateway.

#### Supported Platforms

| Platform | Event Receiving | Streaming | Group Creation | Rich Content |
|----------|----------------|-----------|----------------|--------------|
| [Feishu (Lark)](https://open.feishu.cn/) | WebSocket (长连接) | ✅ Edit-in-place | ✅ Auto-create group | Interactive Cards |
| [DingTalk](https://open.dingtalk.com/) | Stream mode (WS) | ✅ AI Card | ✅ Scene groups | ActionCard / Markdown |
| [Telegram](https://core.telegram.org/bots/api) | Webhook / Long Polling | ✅ sendMessageDraft | ❌ P2P only | MarkdownV2 + InlineKeyboard |
| [WeCom](https://developer.work.weixin.qq.com/) | HTTP Callback (AES XML) | ❌ Batch mode | ✅ App group chat | Markdown / Template Card |
| [Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) | Bot Framework HTTP | ✅ Edit-in-place | ❌ P2P only | Adaptive Cards v1.5 |

#### Common Features

- **P2P entry point**: Private chat with the bot to select projects and sessions
- **Slash commands**: `/cancel`, `/status`, `/mode`, `/model`, `/history`, `/help`
- **Streaming responses**: Real-time AI output with platform-appropriate update strategy
- **Tool summary**: Completion messages include action counts (e.g. `Shell(2), Edit(1)`)
- **Auto-approve permissions**: Engine permission requests are approved automatically

#### Session Models

- **One Group = One Session** (Feishu, DingTalk, WeCom): Each group chat maps to a single CodeMux session. Start in P2P → select project → group auto-created.
- **P2P Direct** (Telegram, Teams): Interact directly in private chat with temporary sessions (2h TTL). In group chats, @mention the bot to interact.

#### Setup

Each platform requires creating a bot/app on its developer portal and configuring credentials in CodeMux Settings → Channels:

| Platform | Required Credentials | Developer Portal |
|----------|---------------------|-----------------|
| Feishu | App ID, App Secret | [open.feishu.cn](https://open.feishu.cn/) |
| DingTalk | App Key, App Secret, Robot Code | [open.dingtalk.com](https://open.dingtalk.com/) |
| Telegram | Bot Token (from @BotFather) | [core.telegram.org](https://core.telegram.org/bots) |
| WeCom | Corp ID, Corp Secret, Agent ID, Callback Token, Encoding AES Key | [developer.work.weixin.qq.com](https://developer.work.weixin.qq.com/) |
| Teams | Microsoft App ID, App Password | [Azure Portal](https://portal.azure.com/) + [Teams Dev Portal](https://dev.teams.microsoft.com/) |

---

## Quick Start

### Option 1: Desktop App

**macOS (Recommended — via Homebrew):**

```bash
brew tap realDuang/codemux
brew install --cask codemux
```

**Manual download:**

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

The desktop app bundles the Cloudflare Tunnel binary and the gateway server. **OpenCode, Copilot CLI, and Claude Code must be installed separately** (see below).

> ⚠️ **macOS Users (manual download)**: The app is not code-signed. If macOS shows "App is damaged", run:
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### Option 2: Development Mode

```bash
# Clone the repository
git clone https://github.com/realDuang/codemux.git
cd codemux

# Install dependencies
bun install

# Download cloudflared binary (for remote access)
bun run update:cloudflared

# Start development server (Electron + Vite HMR)
bun run dev
```

> **Engine Prerequisites**: All engines are external dependencies that must be installed and available in your PATH:
> - **OpenCode**: Install from [opencode.ai](https://opencode.ai) — `curl -fsSL https://opencode.ai/install.sh | bash` (Unix) or `irm https://opencode.ai/install.ps1 | iex` (Windows)
> - **Copilot CLI**: Install [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) separately
> - **Claude Code**: Install via `npm install -g @anthropic-ai/claude-code` and set your `ANTHROPIC_API_KEY`
>
> CodeMux auto-detects installed engines on startup.

---

## Remote Access

### LAN Access

1. Open CodeMux and go to **Remote Access** in settings
2. Find your machine's IP address on the page
3. Open `http://<your-ip>:5173` from another device
4. Enter the 6-digit access code or scan the QR code

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - Remote Access" width="700" />

### Public Internet Access

Access from anywhere with Cloudflare Tunnel — **no port forwarding, no firewall changes, no VPN:**

1. Toggle **"Public Access"** in the Remote Access section
2. Share the generated `*.trycloudflare.com` URL
3. Remote device authenticates with the access code

```
Your Phone/Tablet
       ↓
https://xyz.trycloudflare.com
       ↓
  Cloudflare Network
       ↓
  Your Workstation (CodeMux Gateway)
       ↓
  ┌─────────┬──────────┬───────────┐
  │OpenCode │ Copilot  │  Claude   │
  │ Engine  │  Engine  │  Engine   │
  └─────────┴──────────┴───────────┘
```

### Security & Device Management

| Layer | Protection |
|-------|------------|
| **Device Authorization** | New devices require approval with a 6-digit code |
| **JWT Tokens** | Per-device tokens stored securely |
| **HTTPS** | Public tunnel uses HTTPS via Cloudflare automatically |
| **Ephemeral URLs** | Tunnel URLs change on every restart |

Manage connected devices from the Devices page — view last access time, rename for identification, or revoke access per-device.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - Device Management" width="700" />

> CodeMux is designed for personal use. Revoke devices you no longer use and disable the public tunnel when not needed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI (Desktop via Electron / Web via Browser)            │
│                          │                                      │
│              WebSocket (JSON-RPC)                               │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │    Gateway Server     │                          │
│              │    (Engine Manager)   │                          │
│              └───┬───────┬───────┬───┘                          │
│                  │       │       │                              │
│            ┌─────┘    ┌──┘      ┌┘                              │
│            │          │         │                               │
│      ┌─────┴─────┐ ┌──┴────┐ ┌──┴─────┐                         │
│      │ OpenCode  │ │Copilot│ │ Claude │                         │
│      │ Adapter   │ │Adapter│ │Adapter │                         │
│      │(HTTP+SSE) │ │ (ACP) │ │ (SDK)  │                         │
│      └───────────┘ └───────┘ └────────┘                         │
│                                                                 │
│     Unified Type System: UnifiedPart, ToolPart, AgentMode       │
└─────────────────────────────────────────────────────────────────┘
```

All engines share a **normalized type system** — tool calls, file operations, diffs, and messages are mapped to a common format (`UnifiedPart`), so the UI doesn't need to know which engine is running.

---

## Development

### Commands

```bash
bun run dev              # Electron + Vite HMR
bun run build            # Production build
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS installer
bun run typecheck        # Type checking
bun run update:cloudflared  # Update Cloudflare Tunnel binary
```

### Project Structure

```
codemux/
├── electron/
│   ├── main/
│   │   ├── engines/          # Engine adapters (OpenCode, Copilot, Claude Code)
│   │   ├── gateway/          # WebSocket server + engine routing
│   │   ├── channels/         # IM bot channels (Feishu, DingTalk, Telegram, WeCom, Teams)
│   │   └── services/         # Auth, device store, tunnel, sessions
│   └── preload/
├── src/                      # SolidJS renderer
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UI components + content renderers
│   ├── stores/               # Reactive state (session, message, config)
│   ├── lib/                  # Gateway client, auth, i18n, theme
│   └── types/                # Unified type system + tool mapping
├── scripts/                  # Setup, binary updaters
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## Contributing

Contributions are welcome! Please follow these conventions:

**Code Style**: TypeScript strict mode, SolidJS reactive patterns, Tailwind for styling

**Commit Convention**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**Adding a New Engine**: Implement `EngineAdapter` (see `electron/main/engines/engine-adapter.ts`), add tool name mapping in `src/types/tool-mapping.ts`, and register in `electron/main/index.ts`.

---

## License

[MIT](LICENSE)

---

## Links

- [Issues & Feature Requests](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — Supported engine
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — Supported engine
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Supported engine
- [Feishu Open Platform](https://open.feishu.cn/) — Feishu bot channel
- [DingTalk Open Platform](https://open.dingtalk.com/) — DingTalk bot channel
- [Telegram Bot API](https://core.telegram.org/bots/api) — Telegram bot channel
- [WeCom Developer Center](https://developer.work.weixin.qq.com/) — WeCom bot channel
- [Microsoft Teams Platform](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) — Teams bot channel

---

<div align="center">

**Built with [Electron](https://electronjs.org), [SolidJS](https://solidjs.com), and a love for AI-assisted coding.**

</div>
