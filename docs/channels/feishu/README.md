# Feishu (飞书 / Lark) Channel Setup

Connect CodeMux to Feishu using the official WebSocket SDK — no public URL or Cloudflare Tunnel required.

## Overview

| Feature | Support |
|---------|---------|
| Connection | WebSocket SDK (长连接) — no tunnel needed |
| Streaming | ✅ Edit-in-place (progressive message update) |
| Rich Content | ✅ Interactive Cards with Markdown |
| Group Creation | ✅ Auto-create per session |
| Max Message Size | 28,000 bytes |
| Rate Limit | 5 messages/sec |

## Prerequisites

- A Feishu organization account (企业版 or team edition)
- Admin access to the [Feishu Open Platform](https://open.feishu.cn/)

## Step 1: Create a Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in
2. Click **Create Custom App** (创建企业自建应用)
3. Fill in:
   - **App Name**: e.g., "CodeMux"
   - **App Description**: e.g., "AI coding assistant"
   - **App Icon**: Upload an icon (optional)
4. After creation, go to **Credentials & Basic Info** (凭证与基础信息)
5. Copy the **App ID** and **App Secret** — you will need these later

## Step 2: Enable Bot Capability

1. In the app dashboard, go to **Add Capabilities** (添加应用能力)
2. Enable **Bot** (机器人)
3. Set a bot name (this is what users will see in their chat list)

## Step 3: Configure Event Receiving

1. Go to **Event Configuration** (事件配置)
2. **Important**: Select **Use Long Connection** (使用长连接接收事件)
   > CodeMux uses Feishu's WebSocket SDK to receive events. Do **not** use HTTP callback mode.
3. Subscribe to these events:

| Event | Name | Purpose |
|-------|------|---------|
| `im.message.receive_v1` | Receive messages | **Required** — receives user messages |
| `im.chat.member.bot.added_v1` | Bot added to group | Optional — tracks group membership |
| `im.chat.member.bot.deleted_v1` | Bot removed from group | Optional — cleans up bindings |
| `im.chat.disbanded_v1` | Group disbanded | Optional — cleans up bindings |

## Step 4: Set Permissions

Go to **Permissions & Scopes** (权限管理) and request the following scopes:

| Scope | Purpose | Required |
|-------|---------|----------|
| `im:message` | Send and receive messages | ✅ Yes |
| `im:message:send_as_bot` | Send messages as the bot | ✅ Yes |
| `im:chat` | Read group chat information | ✅ Yes |
| `im:chat:create` | Create group chats | ✅ Yes (for auto-create group) |
| `im:resource` | Access chat resources | Recommended |

After adding permissions, click **Submit for Approval** (提交审核). For enterprise internal apps, approval is usually instant.

## Step 5: Publish the App

1. Go to **Version Management** (版本管理)
2. Click **Create Version** (创建版本)
3. Set the **Availability Scope** (可用范围) — choose which departments/users can use the bot
4. Submit for review
   > Internal apps (企业自建应用) are typically auto-approved

## Step 6: (Optional) Configure Bot Menu

Go to **Bot** (机器人) → **Bot Menu** (机器人菜单) to add quick actions:

| Menu Key | Label | Description |
|----------|-------|-------------|
| `switch_project` | Switch Project | Show project list |
| `new_session` | New Session | Create a new session |
| `switch_session` | Switch Session | Show session list |
| `help` | Help | Display help text |

These appear as clickable buttons in the chat input area.

## Step 7: Configure in CodeMux

1. Open CodeMux → go to the remote access page → **Channels** tab
2. Click **Configure** on the Feishu card
3. Enter:
   - **App ID**: From Step 1
   - **App Secret**: From Step 1
4. Click **Save** — the channel will start automatically

## Usage

### Getting Started

1. Open Feishu and search for your bot name in the contact list
2. Send any message to the bot in a **P2P chat** (private conversation)
3. The bot will show a list of available projects — select one
4. Choose to create a **new session** or use an existing one
5. A **group chat** is automatically created for the session
6. All messages in that group are routed to the AI engine

### Interaction Flow

```
P2P Chat (Entry Point)
  ├─ /project list → Show available projects
  ├─ Select project → Choose or create session
  └─ Group created → Redirected to group chat

Group Chat (Session)
  ├─ Send message → AI engine processes and responds
  ├─ /cancel → Stop current request
  ├─ /mode agent|plan → Switch agent mode
  ├─ /model list → Show available models
  ├─ /status → Show session info
  └─ /history → View recent messages
```

### Streaming

Feishu supports **edit-in-place streaming**: the bot sends a single message and progressively updates it as the AI generates output. You'll see the response build up in real-time.

Update throttle is 1.5 seconds by default to stay within Feishu's API rate limits.

### Session ↔ Group Mapping

- Each CodeMux session is mapped to exactly one Feishu group chat
- The group is named `[ProjectName] SessionTitle`
- When a session's title is updated by the AI engine, the group name is automatically synced
- Group bindings are persisted to disk and survive app restarts

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| Bot doesn't receive messages | Wrong event receiving mode | Ensure **Long Connection** (长连接) is selected, not HTTP callback |
| "Missing appId or appSecret" | Empty credentials | Re-enter App ID and App Secret in CodeMux config |
| Group creation fails | Missing permissions | Verify `im:chat:create` scope is approved |
| Bot doesn't appear in contacts | App not published | Go to Version Management → create and publish a version |
| Messages truncated | Content exceeds 25KB | Normal behavior — long responses are truncated with a notice |
| Permission errors on startup | App not approved | Check version approval status in Feishu Open Platform |
| Duplicate messages | Normal deduplication | Bot uses message ID deduplication (LRU, max 1000 IDs) — safe to ignore |

## Technical Details

- **SDK**: `@larksuiteoapi/node-sdk` (official Lark Node.js SDK)
- **Connection**: WebSocket (WSClient) — persistent connection from CodeMux to Feishu cloud
- **Message Format**: Interactive Cards with Markdown content
- **Persistence**: Group-session bindings saved to `~/.channels/feishu-bindings.json`
- **Rate Limiting**: TokenBucket — 5 burst capacity, 5 tokens/sec refill
