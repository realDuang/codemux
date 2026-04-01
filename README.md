<div align="center">

# CodeMux

**[English](./README.md)** | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Русский](./README.ru.md)

**Multi-Engine AI Coding Client with Full Remote Agent Experience.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*A multi-engine AI coding client with full agent chain-of-thought visualization and zero-config secure remote access — not another chat wrapper.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - Multi-Engine AI Coding Interface" width="800" />

</div>

---

## Why CodeMux?

### 1. Multi-Engine, Not Multi-Model

This is not a chat wrapper that swaps API keys. CodeMux is a **protocol-level gateway** — each engine runs with its own runtime, sessions, tool execution, and capabilities fully preserved.

Switch between engines from a single interface. Each keeps its full power — file editing, shell access, session history, project context — CodeMux just gives them a shared front door.

| Engine | Protocol | Status |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ Stable |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | JSON-RPC/stdio | ✅ Stable |
| **[Claude Code](https://claude.ai/code)** | SDK (stdio) | ✅ Stable |

> 💡 CodeMux is also the **first — and currently only — open-source GUI for GitHub Copilot CLI**, connecting at the protocol level (JSON-RPC over stdio) to deliver Copilot's complete agentic coding experience in a visual interface.

### 2. Agent Chain-of-Thought Visualization

Every agent action is rendered as an expandable step — file diffs, shell commands, search results, tool calls — so you can see exactly what the agent is doing and why, not just the final answer.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - Step-by-Step Agent Visualization" width="700" />

This isn't limited to the desktop app. **The full chain-of-thought experience is preserved across every access method** — whether you're on a browser via LAN or public internet, or interacting through an IM bot on your phone.

### 3. True Remote Agent Experience

Tools like [OpenClaw](https://github.com/openclaw/openclaw) have popularized the idea of accessing AI from messaging apps — send a message on WhatsApp or Telegram, get a text reply. But for AI-assisted coding, a text reply isn't enough. You need to see what the agent is **thinking**, what files it's **editing**, what commands it's **running** — in real time.

**CodeMux bridges this gap.** Whether you access from a browser or an IM platform, you get the complete agent experience with structured streaming:

| Capability | CodeMux | Text-based assistants |
|------------|---------|----------------------|
| Streaming output | ✅ Token-level real-time streaming | ⚠️ Complete reply or chunked text |
| Thinking steps | ✅ Each tool call rendered as expandable step | ❌ Final answer only |
| File diffs | ✅ Inline diff viewer with syntax highlighting | ❌ Plain text or none |
| Shell commands | ✅ Command + output rendered in real time | ❌ Text summary at best |
| Multi-engine | ✅ Switch between OpenCode / Copilot / Claude Code | ❌ Single model / provider |
| Coding context | ✅ Project-aware sessions with full tool access | ⚠️ Generic assistant context |
| Image input | ✅ Paste/drag images for all engines to analyze | ❌ Text-only input |

### 4. Multimodal Support

Text-based coding tools are limited to text input. CodeMux breaks this barrier — **attach images to your prompts and let the AI see what you see**.

Paste a screenshot, drag in a design mockup, or upload an error image — all three engines can analyze images natively. Each engine adapter translates images into its native format behind the scenes, while you get a unified experience:

- **Upload methods**: File picker, drag & drop, clipboard paste
- **Supported formats**: JPEG, PNG, GIF, WebP (up to 4 images per message, 3MB each)
- **Inline preview**: Thumbnails shown before sending, images rendered in chat history

> This works across all access methods — desktop, remote browser, and IM bots — wherever CodeMux runs, image input follows.

### 5. Developer Workflow Tools

CodeMux goes beyond chat — it provides integrated tools to manage your development workflow directly from the interface.

- **Scheduled Tasks**: Automate recurring agent tasks — run code reviews every morning, generate reports on an interval, or batch-process issues weekly. Supports manual trigger, interval (5 min – 12 hours), daily, and weekly scheduling with missed-run catch-up when the app restarts.

- **Git Worktree Parallel Sessions**: Work on multiple branches simultaneously without `git stash`. Create isolated worktrees from the sidebar, each with its own directory, branch, and AI sessions. Merge back with your choice of merge, squash, or rebase — all without leaving the UI.

- **File Explorer & Git Monitoring**: Browse project files with a collapsible tree, preview code with syntax highlighting, and track git changes in real time. A "Changes" tab shows modified files with line-level add/remove counts, and an inline diff viewer lets you inspect every change without leaving CodeMux.

- **Slash Commands & Engine Skills**: Type `/` in the input to invoke engine-native commands and skills with autocomplete — `/cancel`, `/status`, `/mode`, `/model`, and more. Each engine exposes its own commands; Copilot surfaces project-level and personal skills, Claude Code surfaces user-installed skills, and OpenCode passes through its SDK commands — all through a unified autocomplete UI.

### And More

- **Agent mode switching**: Toggle between Build / Plan / Autopilot modes per engine — each with its own behavior and prompt style
- **Live todo panel**: Agent-generated task lists displayed above the input area with real-time progress tracking
- **Permission approvals**: Approve or deny sensitive operations (shell, file edits) inline — with "always allow" for trusted patterns
- **Interactive questions**: Engines can ask single/multi-select questions with descriptions and custom input
- **Per-engine model selection**: Pick different models for each engine independently; Copilot and Claude Code support custom model ID input
- **Token usage tracking**: Monitor input, output, and cache token consumption with per-engine cost breakdowns

#### Browser Remote Access

Access your coding agents from any device — phone, tablet, or another machine — without touching a single config file.

- **LAN**: Auto-detected IP + QR code, ready in seconds
- **Public Internet**: One-click [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — no port forwarding, no VPN, no firewall changes. Supports both **quick tunnels** (random ephemeral URL, zero config) and **named tunnels** (persistent custom domain via `~/.cloudflared/` credentials)
- **Security built-in**: Device authorization, JWT tokens, HTTPS via Cloudflare; quick tunnel URLs rotate on every restart, named tunnels preserve your custom hostname

#### IM Bot Channels

Use your AI coding agents directly from your favorite messaging apps with **real-time streaming and structured rich content** — not just plain text replies.

##### Supported Platforms

| Platform | Event Receiving | Streaming | Group Creation | Rich Content |
|----------|----------------|-----------|----------------|--------------|
| [Feishu (Lark)](https://open.feishu.cn/) | WebSocket (长连接) | ✅ Edit-in-place | ✅ Auto-create group | Interactive Cards |
| [DingTalk](https://open.dingtalk.com/) | Stream mode (WS) | ✅ AI Card | ✅ Scene groups | ActionCard / Markdown |
| [Telegram](https://core.telegram.org/bots/api) | Webhook / Long Polling | ✅ sendMessageDraft | ❌ P2P only | MarkdownV2 + InlineKeyboard |
| [WeCom](https://developer.work.weixin.qq.com/) | HTTP Callback (AES XML) | ❌ Batch mode | ✅ App group chat | Markdown / Template Card |
| [Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) | Bot Framework HTTP | ✅ Edit-in-place | ❌ P2P only | Adaptive Cards v1.5 |

##### Common Features

- **P2P entry point**: Private chat with the bot to select projects and sessions
- **Slash commands**: `/cancel`, `/status`, `/mode`, `/model`, `/history`, `/help`
- **Streaming responses**: Real-time AI output with platform-appropriate update strategy
- **Tool summary**: Completion messages include action counts (e.g. `Shell(2), Edit(1)`)
- **Auto-approve permissions**: Engine permission requests are approved automatically

##### Session Models

- **One Group = One Session** (Feishu, DingTalk, WeCom): Each group chat maps to a single CodeMux session. Start in P2P → select project → group auto-created.
- **P2P Direct** (Telegram, Teams): Interact directly in private chat with temporary sessions (2h TTL). In group chats, @mention the bot to interact.

##### Setup

Each platform requires creating a bot/app on its developer portal and configuring credentials in CodeMux Settings → Channels.

📖 **[Detailed setup guide →](docs/channels/README.md)** — Step-by-step instructions for each platform, including permissions, webhook configuration, and troubleshooting.

| Platform | Required Credentials | Developer Portal |
|----------|---------------------|-----------------|
| Feishu | App ID, App Secret | [open.feishu.cn](https://open.feishu.cn/) |
| DingTalk | App Key, App Secret, Robot Code | [open.dingtalk.com](https://open.dingtalk.com/) |
| Telegram | Bot Token (from @BotFather) | [core.telegram.org](https://core.telegram.org/bots) |
| WeCom | Corp ID, Corp Secret, Agent ID, Callback Token, Encoding AES Key | [developer.work.weixin.qq.com](https://developer.work.weixin.qq.com/) |
| Teams | Microsoft App ID, App Password, Tenant ID | [Azure Portal](https://portal.azure.com/) + [Teams Dev Portal](https://dev.teams.microsoft.com/) |

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

## Remote Access & Channels

### How to Connect

| Method | Setup | Best For |
|--------|-------|----------|
| **LAN Browser** | Open `http://<your-ip>:8233`, enter 6-digit code or scan QR | Quick access from another device on the same network |
| **Public Internet** | Toggle "Public Access" → share `*.trycloudflare.com` URL | Access from anywhere, no port forwarding needed |
| **IM Bot** | Configure bot credentials in Settings → Channels | Interact from Feishu, DingTalk, Telegram, WeCom, or Teams |

### Security & Device Management

| Layer | Protection |
|-------|------------|
| **Device Authorization** | New devices require approval with a 6-digit code |
| **JWT Tokens** | Per-device tokens stored securely |
| **HTTPS** | Public tunnel uses HTTPS via Cloudflare automatically |
| **Ephemeral URLs** | Tunnel URLs change on every restart |

Manage connected devices from the Devices page — view last access time, rename for identification, or revoke access per-device.

> CodeMux is designed for personal use. Revoke devices you no longer use and disable the public tunnel when not needed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Access Layer                             │
│                                                                 │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
│  │ Electron │  │ Browser (LAN/ │  │ IM Bots (Feishu/DingTalk │  │
│  │   App    │  │  Cloudflare)  │  │ /Telegram/WeCom/Teams)   │  │
│  └────┬─────┘  └──────┬────────┘  └────────────┬─────────────┘  │
│       │               │                        │                │
│       └───────────────┼────────────────────────┘                │
│                       │                                         │
│              WebSocket (JSON-RPC)                               │
│                       │                                         │
│              ┌────────┴────────┐                                │
│              │  Gateway Server │                                │
│              │ (Engine Manager)│                                │
│              └──┬──────┬─────┬┘                                 │
│                 │      │     │                                  │
│           ┌─────┘   ┌──┘    └──┐                                │
│           │         │          │                                │
│     ┌─────┴─────┐ ┌─┴──────┐ ┌┴───────┐                        │
│     │ OpenCode  │ │Copilot │ │ Claude │                        │
│     │ Adapter   │ │Adapter │ │Adapter │                        │
│     │(HTTP+SSE) │ │(stdio) │ │ (SDK)  │                        │
│     └───────────┘ └────────┘ └────────┘                        │
│                                                                 │
│     Unified Type System: UnifiedPart, ToolPart, AgentMode       │
└─────────────────────────────────────────────────────────────────┘
```

All access methods — desktop app, remote browser, and IM bots — connect through the same WebSocket gateway. Engines share a **normalized type system**, so tool calls, file diffs, and streaming messages are rendered identically regardless of which engine or access method is used.

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
│   │   │   └── streaming/    # Cross-channel streaming infrastructure
│   │   ├── services/         # Auth, device store, tunnel, sessions, file service, tray, etc.
│   │   └── utils/            # Shared utilities (ID generation, etc.)
│   └── preload/
├── src/                      # SolidJS renderer
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UI components + content renderers
│   ├── stores/               # Reactive state (session, message, config)
│   ├── lib/                  # Gateway client, auth, i18n, theme
│   ├── locales/              # i18n translation files (en, zh, ru)
│   └── types/                # Unified type system + tool mapping
├── shared/                   # Shared backend modules (auth, JWT, device store base)
├── tests/                    # Unit tests, e2e tests (Playwright), benchmarks
├── docs/                     # Channel setup guides + design documents
├── website/                  # Project website (SolidJS + Vite)
├── scripts/                  # Setup, binary updaters, CI helpers
├── homebrew/                 # Homebrew formula for macOS distribution
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

**Code Style**: TypeScript strict mode, SolidJS reactive patterns, Tailwind for styling

**Commit Convention**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**Adding a New Engine**: Implement `EngineAdapter` (see `electron/main/engines/engine-adapter.ts`), add tool name mapping in `src/types/tool-mapping.ts`, and register in `electron/main/index.ts`.

---

## License

[MIT](LICENSE)

---

## Links

- [Discussions](https://github.com/realDuang/codemux/discussions) — Roadmap, feature requests & community conversations
- [Roadmap](https://github.com/realDuang/codemux/discussions/61) — Development roadmap and milestone tracking
- [Issues](https://github.com/realDuang/codemux/issues) — Bug reports
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
