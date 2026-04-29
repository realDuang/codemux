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
| WeChat iLink (微信个人号) | HTTP long-poll | ❌ Batch mode | ❌ P2P only | Plain text | [→ Setup](weixin-ilink/README.md) |

## Connection Types

| Type | Platforms | Tunnel Required | How It Works |
|------|-----------|----------------|--------------|
| **Direct Connect** | Feishu / Lark, DingTalk, Telegram (polling) | No | Platform SDK maintains persistent connection from CodeMux to the platform's servers |
| **Webhook** | WeCom, Teams, Telegram (webhook) | Yes | Platform sends HTTP requests to your CodeMux instance via [Cloudflare Tunnel](../../README.md) |

## Session Models

| Model | Platforms | Flow |
|-------|-----------|------|
| **One Group = One Session** | Feishu / Lark, DingTalk, WeCom | P2P chat → select project → group auto-created → all messages in that group go to one CodeMux session |
| **P2P Direct** | Telegram, Teams, WeChat iLink | Interact directly in private chat with temporary sessions. In group chats (Telegram / Teams), @mention the bot |

## Common Features

All channels support the same unified slash-command surface (powered by `electron/main/channels/shared`). Streaming and rich-content support varies by platform — see the table above.

## Common Commands Reference

Commands are split into two groups by capability. Channels expose the right subset based on the chat context (P2P vs group).

### P2P chat (entry point) — full command set

| Command | Description |
|---------|-------------|
| `/project` | Show project list (reply with a number to switch) |
| `/new` | Create a new session in the current project (auto-creates a group on Feishu/DingTalk/WeCom) |
| `/switch` | Show session list for the current project (reply with a number to open) |
| `/cancel` | Cancel the in-flight AI request |
| `/status` | Show current session info |
| `/mode <agent\|plan\|build>` | Switch agent mode |
| `/model [list\|<id>]` | List available models, or switch to a specific id |
| `/history` | Show recent message history |
| `/help` | Show all available commands |
| `/start` | Same as `/help` (welcome alias used by Telegram / Teams) |

### Group / channel chat — session-ops only

In a session group (Feishu/DingTalk/WeCom auto-created group, or a Telegram/Teams group with the bot @mentioned), navigation commands are hidden because the group **is** the session. Available commands:

`/cancel`, `/status`, `/mode`, `/model`, `/history`, `/help`

> In Telegram and Teams groups you must `@mention` the bot or prefix with `/command` for the bot to receive the message. In Feishu / DingTalk / WeCom session groups, every message is forwarded to the AI engine automatically.

## Architecture

```
IM Platform (Feishu/Lark/DingTalk/Telegram/WeCom/Teams/WeChat iLink)
  ↕ Messages (SDK WebSocket or HTTP Webhook)
Channel Adapter (in CodeMux)
  ↕ WebSocket (internal)
Gateway Server
  ↕ Engine routing
AI Engine (OpenCode / Copilot / Claude Code / Codex experimental)
```

Each channel adapter connects to the CodeMux gateway using the same WebSocket protocol as the web UI, ensuring feature parity.
