# Channel Integration Guide

Connect CodeMux to your favorite messaging platforms to interact with AI coding engines directly from IM apps — with real-time streaming, tool execution, and multi-engine access.

## Supported Platforms

| Platform | Connection | Streaming | Group Creation | Rich Content | Guide |
|----------|-----------|-----------|----------------|--------------|-------|
| [Feishu / Lark](feishu/README.md) | WebSocket SDK | ✅ Edit-in-place | ✅ Auto-create | Interactive Cards | [→ Setup](feishu/README.md) |
| [DingTalk (钉钉)](dingtalk/README.md) | Stream mode (WS) | ✅ AI Card | ✅ Scene groups | ActionCard / Markdown | [→ Setup](dingtalk/README.md) |
| [Telegram](telegram/README.md) | Webhook / Long Polling | ✅ Draft / Edit | ❌ P2P only | MarkdownV2 + Buttons | [→ Setup](telegram/README.md) |
| [WeCom (企业微信)](wecom/README.md) | HTTP Callback (AES XML) | ❌ Batch mode | ✅ App group chat | Markdown | [→ Setup](wecom/README.md) |
| [Microsoft Teams](teams/README.md) | Bot Framework HTTP | ✅ Edit-in-place | ❌ P2P only | Adaptive Cards v1.5 | [→ Setup](teams/README.md) |

## Connection Types

| Type | Platforms | Tunnel Required | How It Works |
|------|-----------|----------------|--------------|
| **Direct Connect** | Feishu / Lark, DingTalk, Telegram (polling) | No | Platform SDK maintains persistent connection from CodeMux to the platform's servers |
| **Webhook** | WeCom, Teams, Telegram (webhook) | Yes | Platform sends HTTP requests to your CodeMux instance via [Cloudflare Tunnel](../../README.md) |

## Session Models

| Model | Platforms | Flow |
|-------|-----------|------|
| **One Group = One Session** | Feishu / Lark, DingTalk, WeCom | P2P chat → select project → group auto-created → all messages in that group go to one CodeMux session |
| **P2P Direct** | Telegram, Teams | Interact directly in private chat with temporary sessions. In group chats, @mention the bot |

## Common Features

All channels support:
- **Slash commands**: `/project`, `/session`, `/engine`, `/model`, `/cancel`, `/status`, `/mode`, `/history`, `/help`
- **Streaming responses**: Real-time AI output with platform-appropriate update strategy
- **Tool summaries**: Completion messages include action counts (e.g., `Shell(2), Edit(1)`)
- **Auto-approve**: Engine permission requests are approved automatically

## Common Commands Reference

| Command | Description |
|---------|-------------|
| `/project list` | List all available projects |
| `/project switch <name>` | Switch to a different project |
| `/session list` | List sessions in current project |
| `/session new` | Create a new session |
| `/session switch <id>` | Switch to a specific session |
| `/session delete <id>` | Delete a session |
| `/engine list` | List available AI engines |
| `/model list` | List available models |
| `/model <id>` | Switch to a specific model |
| `/mode <mode>` | Switch agent mode (e.g., `plan`, `agent`) |
| `/cancel` | Cancel the current AI request |
| `/status` | Show current session status |
| `/history` | Show recent message history |
| `/help` | Show all available commands |

## Architecture

```
IM Platform (Feishu/Lark/DingTalk/Telegram/WeCom/Teams)
  ↕ Messages (SDK WebSocket or HTTP Webhook)
Channel Adapter (in CodeMux)
  ↕ WebSocket (internal)
Gateway Server
  ↕ Engine routing
AI Engine (OpenCode / Copilot / Claude Code / Codex experimental)
```

Each channel adapter connects to the CodeMux gateway using the same WebSocket protocol as the web UI, ensuring feature parity.
