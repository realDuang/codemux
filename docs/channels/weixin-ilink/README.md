# WeChat iLink (微信个人号) Channel Setup

Connect CodeMux to your **personal WeChat account** via the [WeChat iLink](https://ilinkai.weixin.qq.com) bot platform — log in once with QR code, then chat with the AI engine in any private WeChat conversation.

> ⚠️ **Personal-account integration.** iLink hangs an automation session off your real WeChat ID. Treat the bot token like your WeChat password: never share it, never commit it. If WeChat detects abuse the underlying account may be temporarily restricted. Use it on a low-risk account you control.

## Overview

| Feature | Support |
|---------|---------|
| Connection | HTTP long-poll (no tunnel needed) |
| Streaming | ❌ Batch mode (iLink has no message-edit / delete API) |
| Rich Content | ❌ Plain text only |
| Group Creation | ❌ P2P only — iLink does not expose group APIs |
| Group Chat | ❌ Inbound group messages are not delivered to iLink bots |
| Max Message Size | ~4,096 bytes |
| Authentication | QR-code login (no developer registration required) |

## Prerequisites

- A personal WeChat account on a phone with WeChat installed
- Network access to `ilinkai.weixin.qq.com` from the machine running CodeMux

## Step 1: Open the Login Modal

1. Open CodeMux → go to the remote access page → **Channels** tab
2. Find the **WeChat iLink** card and click **Login**
3. A modal opens and CodeMux fetches a QR code from iLink

## Step 2: Scan With WeChat

1. Open WeChat on your phone → tap the **+** button → **Scan**
2. Scan the QR code shown in the modal
3. Confirm the login on your phone

The modal will progress through stages: `loading` → `ready` → `scanned` → `confirmed` → success. CodeMux automatically saves the resulting `botToken` and `accountId` and starts the bot.

> The QR code expires after a short time. If you see "QR code expired", click **Refresh QR code** and rescan.

## Step 3: Chat With the Bot

1. In WeChat, find the bot account that just appeared in your contacts (it carries the iLink branding)
2. Send `/help` to see available commands, or send any message to start chatting
3. On first message in a fresh chat the bot will prompt you to pick a project, then create a temporary P2P session bound to that chat

## Usage

### P2P (Private Chat) — only mode supported

- Every chat is a **temporary P2P session** scoped to that conversation
- Sessions are kept alive for 2 hours of inactivity, then garbage-collected
- Use `/new` to discard the current session and start a fresh one for the same project
- Use `/switch` to jump to another existing session in the current project

### Streaming Behavior

iLink does **not** support editing or deleting sent messages. CodeMux therefore runs in **batch mode**:

- The AI's reply arrives as one or more complete chunks once each turn finishes
- No "typing…" effect, no live token streaming
- Long replies are split into multiple messages, each ≤ 4 KB

If you need true streaming, use Telegram, Feishu, or DingTalk instead.

### Commands

Send `/help` in any chat to see the full list. The unified command surface is identical to other channels — see the [common commands reference](../README.md#common-commands-reference). Quick recap:

| Command | Description |
|---------|-------------|
| `/project` | Switch project |
| `/new` | Start a new session in the current project |
| `/switch` | Switch to another session in the current project |
| `/cancel` | Cancel the in-flight AI request |
| `/status` | Show current session info |
| `/mode <agent\|plan\|build>` | Switch agent mode |
| `/model [list\|<id>]` | List or switch model |
| `/history` | Show recent message history |
| `/help` | Show this help |

## Logging Out / Switching Accounts

To sign out of WeChat, switch to a different WeChat ID, or simply disable the channel cleanly:

1. On the WeChat iLink card, click **Logout** (the red button replaces **Login** once you're signed in)
2. Confirm in the dialog

What happens:

- The long-poll loop and gateway connection are torn down
- All persisted session bindings on this device are cleared (`weixin-ilink-bindings.json` is wiped)
- The `botToken` and `accountId` are erased from the channel config and the channel is marked **disabled** so it doesn't auto-restart on next launch
- After logout the toggle switch is **disabled** until you log in again

> ℹ️ Logout only clears local state. CodeMux does **not** call any iLink "revoke token" API (none is publicly documented). The remote WeChat session may stay valid until it expires server-side, but without the token it cannot be used.

## Auto Token-Expiry Handling

iLink returns `errcode == -14` when the bot token is invalidated server-side (token expired, account restricted, etc.). CodeMux's long-poll loop detects this within seconds and automatically:

1. Stops polling
2. Calls the same logout flow described above (clears bindings + credentials, marks channel disabled)
3. Surfaces a red error banner on the channel card: *"WeChat session expired — please scan the QR code again to re-login."*

You'll need to click **Login** and rescan the QR code to bring the bot back.

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| QR code never loads | Network can't reach `ilinkai.weixin.qq.com` | Check firewall / proxy; the host is in mainland China |
| QR code expires before scan | Took longer than the iLink-issued TTL | Click **Refresh QR code** |
| "Session expired — please scan the QR code again" | iLink invalidated the token (timeout, conflict, manual revocation) | Click **Login** and rescan |
| Toggle switch is greyed out | Not logged in (`botToken` / `accountId` empty) | Click **Login** first |
| Bot never replies in chat | Channel not running, or no `context_token` cached yet | Check the green dot on the card; make sure the user sent at least one inbound message after login (iLink only allows replies after receiving a message) |
| Replies arrive in chunks instead of streaming | Expected — iLink has no edit-message API | Use Telegram / Feishu / DingTalk for live streaming |
| Group messages ignored | iLink bots only receive P2P messages | Use a different channel for group chat |
| Same message processed twice | Long-poll cursor lost | The dedup cache (1000 most-recent message IDs) usually catches this; restart the channel if it persists |

## Technical Details

- **API base**: `https://ilinkai.weixin.qq.com` (overridable per response)
- **Auth header**: `Authorization: Bearer <botToken>`, plus `AuthorizationType: ilink_bot_token` and `X-WECHAT-UIN` (random base64 uint32)
- **Polling**: `POST /ilink/bot/getupdates` long-poll, server holds up to ~35s
- **Sending**: `POST /ilink/bot/sendmessage`, requires the per-recipient `context_token` captured from the latest inbound message (no expiry, server-issued)
- **Session expiry signal**: `errcode == -14` or `ret == -14`
- **Capabilities**: `supportsMessageUpdate=false`, `supportsMessageDelete=false`, `supportsRichContent=false`, `maxMessageBytes=4096` → `StreamingController` runs in batch mode
- **Persistence**:
  - Channel config: `~/Library/Application Support/codemux/channels/weixin-ilink.json` (or `.channels/weixin-ilink.json` in dev)
  - Session bindings: `~/Library/Application Support/codemux/channels/weixin-ilink-bindings.json`
- **Temp session TTL**: 2 hours of inactivity, then garbage-collected
- **Reference**: protocol verified against [hello-halo](https://github.com/) `ilink-api.ts`
