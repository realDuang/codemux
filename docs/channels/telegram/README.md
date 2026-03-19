# Telegram Channel Setup

Connect CodeMux to Telegram via long polling (no tunnel needed) or webhook mode (lower latency, requires tunnel).

## Overview

| Feature | Support |
|---------|---------|
| Connection | Long polling (no tunnel) or Webhook (needs tunnel) |
| Streaming | ✅ sendMessageDraft (Bot API 9.3+) / edit-in-place |
| Rich Content | ✅ MarkdownV2 + InlineKeyboard buttons |
| Group Creation | ❌ P2P only (bot can be added to existing groups) |
| Max Message Size | ~4,096 characters |
| Rate Limit | 30 messages/sec |

## Prerequisites

- A Telegram account
- Access to [@BotFather](https://t.me/BotFather)

## Step 1: Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts:
   - Enter a **display name** for your bot (e.g., "CodeMux Bot")
   - Enter a **username** (must end with `bot`, e.g., `codemux_bot`)
4. BotFather will reply with your **Bot Token**. Copy it.
   > ⚠️ Keep this token secret. Anyone with it can control your bot.

## Step 2: Configure Bot Settings (Recommended)

Still in BotFather, run these commands:

### Set Command Menu

Send `/setcommands`, select your bot, then paste:
```
project - Manage projects
session - Manage sessions
cancel - Cancel current request
status - Show session status
mode - Change agent mode
model - Change AI model
history - View message history
help - Show help
```

### Set Privacy Mode

Send `/setprivacy`, select your bot, then choose **Disable**.

> This allows the bot to see all messages in group chats, not just @mentions. If you prefer privacy, keep it enabled — users will need to @mention the bot in groups.

### Set Description (Optional)

Send `/setdescription` to add a description shown when users first open the bot.

## Step 3: Choose Connection Mode

### Option A: Long Polling (Easiest — No Tunnel Needed)

- Leave the **Webhook URL** field empty in CodeMux config
- CodeMux polls Telegram's servers for updates automatically
- Works behind firewalls, NAT, VPNs — no public URL needed
- Slightly higher latency (~1-2 seconds)

### Option B: Webhook (Lower Latency — Requires Tunnel)

- Set up a [Cloudflare Tunnel](../../README.md) first
- Your webhook URL will be: `https://your-tunnel-domain/webhook/telegram`
- Telegram sends updates instantly via HTTPS POST
- Optionally set a **Webhook Secret Token** for security — Telegram will include it in `X-Telegram-Bot-Api-Secret-Token` header

## Step 4: Configure in CodeMux

1. Open CodeMux → go to the remote access page → **Channels** tab
2. Click **Configure** on the Telegram card
3. Enter:
   - **Bot Token**: From Step 1
   - **Webhook URL** (optional): `https://your-tunnel-domain/webhook/telegram` (leave empty for polling)
4. Click **Save** — the channel will start automatically

## Usage

### Getting Started

1. Open Telegram and search for your bot by username
2. Click **Start** or send any message
3. The bot shows available projects — select one
4. Send messages to interact with the AI engine

### P2P (Private Chat)

- Primary interaction mode
- Full streaming support (sendMessageDraft)
- All commands available
- Messages appear with real-time typing indicator

### Group Chat

- Add the bot to an existing group
- @mention the bot to interact: `@codemux_bot your question here`
- No draft streaming in groups — falls back to edit-in-place
- Bot cannot create groups — users must add it manually

### Streaming

Telegram supports two streaming strategies:

| Mode | How It Works | When Used |
|------|-------------|-----------|
| **sendMessageDraft** (default) | Native Bot API 9.3+ feature — shows typing indicator with live text update | P2P chats |
| **editMessageText** (fallback) | Bot sends a message then edits it as new content arrives | Group chats, older API |

If streaming appears broken, try setting `useMessageDraft: false` in the advanced config.

### Commands

Type `/help` in chat to see all available commands. Commands work in both P2P and group chats.

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| Bot doesn't respond | Token invalid or expired | Regenerate token via @BotFather → `/token` |
| Webhook not receiving | URL not accessible | Verify Cloudflare Tunnel is running and URL is HTTPS |
| "Conflict: can't use getUpdates" | Webhook is set but polling expected | Clear webhook: visit `https://api.telegram.org/bot<TOKEN>/deleteWebhook` |
| No response in groups | Privacy mode enabled | Either @mention the bot or disable privacy via @BotFather |
| Messages truncated | Exceeds 4,096 char limit | Normal — Telegram enforces this limit. Long responses are split |
| Streaming not working | Old Telegram client | Set `useMessageDraft: false` to fall back to editMessageText |
| Duplicate responses | Bot processed update twice | Check for multiple CodeMux instances running with same token |

## Technical Details

- **API**: Telegram Bot HTTP API (`https://api.telegram.org/bot<TOKEN>/`)
- **Webhook Endpoint**: `/webhook/telegram` (POST)
- **Webhook Auth**: Optional `X-Telegram-Bot-Api-Secret-Token` header verification
- **Message Format**: MarkdownV2 with InlineKeyboardMarkup for interactive elements
- **Persistence**: Session bindings saved to `~/.channels/telegram-bindings.json`
- **Rate Limiting**: TokenBucket — 10 burst capacity, 30 tokens/sec refill
