<div align="center">

# CodeMux

**[English](./README.md)** | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md)

**One Interface. Every AI Coding Engine.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*A unified desktop & web client for multiple AI coding engines — OpenCode, GitHub Copilot CLI, and more. Access them all from any device, anywhere.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - Multi-Engine AI Coding Interface" width="800" />

</div>

---

## What is CodeMux?

AI coding agents are powerful — but fragmented. OpenCode, GitHub Copilot CLI, Claude Code each run in their own terminal with separate sessions, different protocols, and no shared interface.

**CodeMux** is a multi-engine gateway that brings them all into one place. It connects to each engine at the protocol level and provides a unified desktop app and web interface to manage sessions across engines — from any device, even over the internet.

This is not another multi-model chat wrapper. Each engine keeps its full capabilities — tool execution, file editing, shell access, session history — CodeMux just gives them a shared front door.

---

## Key Features

| Category | Feature | Description |
|----------|---------|-------------|
| **Multi-Engine** | Unified Gateway | Switch between OpenCode, Copilot CLI, and more from a single interface |
| | Protocol-Level Integration | Direct ACP (JSON-RPC/stdio) and HTTP+SSE connections — not process wrappers |
| | Per-Engine Sessions | Each engine maintains its own sessions, history, and capabilities |
| **Remote Access** | Access from Any Device | Use your phone, tablet, or any browser to reach your coding engines |
| | One-Click Public Tunnel | Cloudflare Tunnel — no port forwarding, no VPN, no firewall changes |
| | LAN + QR Code | Instant local network access with QR code for mobile devices |
| **Interface** | Real-time Streaming | Live token streaming with tool call visualization |
| | Step-by-Step Execution | Expandable tool calls showing file diffs, shell output, and more |
| | Project Management | Group sessions by project directory across engines |
| **Security** | Device Authorization | Each device must be approved before accessing |
| | JWT + Access Codes | Token-based auth with 6-digit access codes for remote devices |
| | Ephemeral Tunnel URLs | Public URLs rotate on every tunnel restart |

---

## Supported Engines

| Engine | Protocol | Status | Highlights |
|--------|----------|--------|------------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ Stable | Multi-provider model selection, full session management, file/shell tools |
| **[GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)** | ACP (JSON-RPC/stdio) | ✅ Stable | Native ACP integration, SQLite session history, Copilot's full agentic capabilities |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 Planned | Waiting for official ACP protocol support |

### First Open-Source GUI for Copilot CLI

GitHub Copilot is the most widely adopted AI coding tool in the world. With **Copilot CLI**, GitHub brought agentic coding capabilities to the terminal through the [ACP protocol](https://github.com/anthropics/agent-control-protocol).

**CodeMux is the first — and currently only — open-source project that provides a graphical interface for Copilot CLI.** No other tool offers protocol-level ACP integration with a full GUI. If you use Copilot and want a visual interface for agentic coding, CodeMux is the only open-source option.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - Step-by-Step Tool Execution" width="700" />

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
│                  │       │       │                               │
│           ┌──────┘   ┌───┘   ┌───┘                              │
│           │          │       │                                   │
│     ┌─────┴─────┐ ┌──┴───┐ ┌─┴──────┐                          │
│     │ OpenCode  │ │Copilot│ │ Claude │                          │
│     │ Adapter   │ │Adapter│ │Adapter │                          │
│     │(HTTP+SSE) │ │ (ACP) │ │ (ACP)  │                          │
│     └───────────┘ └──────┘ └────────┘                           │
│                                                                  │
│     Unified Type System: UnifiedPart, ToolPart, AgentMode        │
└─────────────────────────────────────────────────────────────────┘
```

All engines share a **normalized type system** — tool calls, file operations, diffs, and messages are mapped to a common format (`UnifiedPart`), so the UI doesn't need to know which engine is running.

---

## Quick Start

### Option 1: Desktop App

Download the latest release for your platform:

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

The desktop app bundles the Cloudflare Tunnel binary and the gateway server. **OpenCode and Copilot CLI must be installed separately** (see below).

> ⚠️ **macOS Users**: The app is not code-signed. If macOS shows "App is damaged", run:
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

> **Engine Prerequisites**: Both engines are external dependencies that must be installed and available in your PATH:
> - **OpenCode**: Install from [opencode.ai](https://opencode.ai) — `curl -fsSL https://opencode.ai/install.sh | bash` (Unix) or `irm https://opencode.ai/install.ps1 | iex` (Windows)
> - **Copilot CLI**: Install [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) separately
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

Access from anywhere with Cloudflare Tunnel:

1. Toggle **"Public Access"** in the Remote Access section
2. Share the generated `*.trycloudflare.com` URL
3. Remote device authenticates with the access code

**No port forwarding. No firewall changes. No VPN.**

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

### Device Management

- **View** all connected devices with last access time
- **Rename** devices for easy identification
- **Revoke** access per-device or revoke all at once

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - Device Management" width="700" />

---

## Security

| Layer | Protection |
|-------|------------|
| **Device Authorization** | New devices require approval with a 6-digit code |
| **JWT Tokens** | Per-device tokens stored securely |
| **HTTPS** | Public tunnel uses HTTPS via Cloudflare automatically |
| **Ephemeral URLs** | Tunnel URLs change on every restart |

**Best Practices:**
- Revoke access from devices you no longer use
- Disable public tunnel when not needed
- CodeMux is designed for personal use — not multi-user scenarios

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Shell | Electron 33 |
| Build System | electron-vite (Vite 5) |
| Frontend | SolidJS 1.8 + TypeScript 5 |
| Styling | Tailwind CSS v4 |
| Engine Communication | WebSocket + JSON-RPC, HTTP+SSE, ACP (stdio) |
| Packaging | electron-builder (DMG, NSIS) |
| Tunnel | Cloudflare Tunnel (cloudflared) |

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
│   │   ├── engines/          # Engine adapters (OpenCode, Copilot, ACP base)
│   │   ├── gateway/          # WebSocket server + engine routing
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

---

<div align="center">

**Built with [Electron](https://electronjs.org), [SolidJS](https://solidjs.com), and a love for AI-assisted coding.**

</div>
