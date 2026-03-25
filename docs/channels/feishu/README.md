# Feishu / Lark Channel Setup

Connect CodeMux to Feishu or Lark using the official WebSocket SDK — no public URL or Cloudflare Tunnel required.

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

- A Feishu or Lark organization account with a self-built/private app
- Admin access to the matching developer console:
  - Feishu: [open.feishu.cn](https://open.feishu.cn/)
  - Lark: [open.larksuite.com](https://open.larksuite.com/)

## Step 1: Create a Feishu or Lark App

1. Go to the matching developer console and log in:
   - Feishu: [open.feishu.cn/app](https://open.feishu.cn/app)
   - Lark: [open.larksuite.com/app](https://open.larksuite.com/app)
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
   > CodeMux uses the Feishu / Lark WebSocket SDK to receive events. Do **not** use HTTP callback mode.
3. Subscribe to these events:

| Event | Name | Required | Purpose |
|-------|------|----------|---------|
| `im.message.receive_v1` | Receive messages (接收消息) | ✅ Yes | Receives user messages in P2P and group chats |
| `application.bot.menu_v6` | Bot menu event (机器人自定义菜单事件) | ✅ Yes | Receives custom menu click events |
| `im.chat.disbanded_v1` | Group disbanded (解散群) | ✅ Yes | Cleans up session bindings when group is dissolved |
| `im.chat.member.bot.deleted_v1` | Bot removed from group (机器人被移出群) | ✅ Yes | Cleans up session bindings when bot is removed |
| `im.chat.member.user.deleted_v1` | User left/removed from group (用户主动退群或被移出群聊) | ✅ Yes | Cleans up session when the group owner leaves |
| `im.chat.member.bot.added_v1` | Bot added to group (机器人进群) | Recommended | Tracks group membership changes |
| `im.chat.access_event.bot_p2p_chat_entered_v1` | User enters bot P2P chat | Recommended | Suppressed internally, subscribe to avoid SDK warnings |
| `im.message.message_read_v1` | Message read (消息已读) | Recommended | Suppressed internally, subscribe to avoid SDK warnings |

## Step 4: Set Permissions

Go to **Permissions & Scopes** (权限管理) and request the following scopes.

> **Tip**:
> - **Feishu**: use [`feishu-scopes.json`](feishu-scopes.json). In the Feishu developer console, go to **Permissions & Scopes** → **Batch Enable** (批量开通), and paste the JSON payload there.
> - **Lark**: use [`lark-scopes.json`](lark-scopes.json) if your Lark tenant exposes a bulk paste/import field. Lark uses the default template shape `{"scopes":{"tenant":[...],"user":[...]}}`, not the Feishu batch-enable helper format. CodeMux currently needs only **tenant** scopes, so the `user` array stays empty. If your Lark console only shows checkboxes, enable the same scopes manually from the tables below.

### API Call Permissions

These scopes are required for the bot to call Feishu / Lark APIs (send messages, manage groups, etc.):

| Scope | Description | Purpose | Required |
|-------|-------------|---------|----------|
| `im:message` | 获取与发送单聊、群组消息 | Core messaging — send, edit, delete messages | ✅ Yes |
| `im:message:send_as_bot` | 以应用的身份发消息 | Send messages with bot identity | ✅ Yes |
| `im:message:send` | 发送消息V2 | Send messages (newer API version) | ✅ Yes |
| `im:message:update` | 更新消息 | Edit messages (used for streaming updates) | ✅ Yes |
| `im:message:recall` | 撤回消息 | Delete (recall) bot messages | ✅ Yes |
| `im:chat` | 获取与更新群组信息 | Create and update group chats | ✅ Yes |
| `im:chat:create` | 创建群 | Create group chats for sessions | ✅ Yes |
| `im:chat:update` | 更新群信息 | Update group chat name when session title changes | ✅ Yes |
| `im:chat:operate_as_owner` | 更新应用所创建群的群信息 | Manage groups created by the bot | Recommended |
| `im:resource` | 获取消息中的资源文件 | Access message resources (images, files) | Recommended |

### Event Subscription Permissions

These scopes control **which events** the bot can receive. They are separate from API call permissions — you must enable them for the event subscriptions in Step 3 to work:

| Scope | Description | Events Covered | Required |
|-------|-------------|----------------|----------|
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | `im.message.receive_v1` — P2P messages | ✅ Yes |
| `im:message.group_msg:readonly` | 获取群聊中所有的用户聊天消息 | `im.message.receive_v1` — all group messages | ✅ Yes |
| `im:chat:readonly` | 获取群组信息 | `im.chat.disbanded_v1`, bot added/removed events | ✅ Yes |
| `im:chat.members:bot_access` | 订阅机器人进、出群事件 | `im.chat.member.bot.added_v1`, `im.chat.member.bot.deleted_v1` | Recommended |

> **Important**: `im:message.group_msg:readonly` (not `im:message.group_at_msg:readonly`) is required. CodeMux needs to receive **all** messages in group chats, not just messages that @mention the bot.

> **Note**: The `application.bot.menu_v6` event requires **no** additional permission scope — it is available to all apps with bot capability enabled.

After adding all permissions, click **Submit for Approval** (提交审核). For enterprise internal apps, approval is usually instant.

The Feishu and Lark helper files contain the same effective permissions, but the wrapper format is different:

- `feishu-scopes.json`: richer helper object for the Feishu batch-enable dialog
- `lark-scopes.json`: Lark default template with `scopes.tenant` and `scopes.user`

## Step 5: Configure Bot Custom Menu

The bot custom menu provides clickable quick-action buttons in the chat input area. This is the primary way for users to navigate projects and sessions from their mobile devices.

1. In the app dashboard, go to **Bot** (机器人) → **Bot Menu** (机器人菜单)
2. Click **Add Menu** (添加菜单) for each item below
3. For each menu item, select **Type** = **Event** (事件), not "Redirect URL"
4. Enter the **Event Key** (事件标识) exactly as shown:

| Event Key | Label (CN) | Label (EN) | Description |
|-----------|-----------|-----------|-------------|
| `switch_project` | 切换项目 | Switch Project | Show project list for selection |
| `new_session` | 新建会话 | New Session | Create a new session in the last-used project |
| `switch_session` | 切换会话 | Switch Session | Show session list for the last-used project |
| `help` | 帮助 | Help | Display available commands and usage guide |

> **Note**: The event keys above must match exactly — they are hardcoded in CodeMux's bot menu handler. You can customize the display labels freely.

5. Save the menu configuration

When a user clicks a menu item, Feishu sends an `application.bot.menu_v6` event to CodeMux. The bot responds in the user's P2P chat with the appropriate content (project list, session list, help text, etc.).

## Step 6: Publish the App

1. Go to **Version Management** (版本管理)
2. Click **Create Version** (创建版本)
3. Set the **Availability Scope** (可用范围) — choose which departments/users can use the bot
4. Submit for review
   > Internal or private self-built apps are typically auto-approved more quickly than store apps

## Step 7: Configure in CodeMux

1. Open CodeMux → go to the remote access page → **Channels** tab
2. Click **Configure** on the Feishu / Lark card
3. Enter:
   - **Platform**: Select **Feishu** for `open.feishu.cn` apps or **Lark** for `open.larksuite.com` apps
   - **App ID**: From Step 1
   - **App Secret**: From Step 1
4. Click **Save** — the channel will start automatically

## Usage

### Getting Started

1. Open Feishu or Lark and search for your bot name in the contact list
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
| Bot receives P2P but not group messages | Missing event permission | Enable `im:message.group_msg:readonly` (not just `im:message.group_at_msg:readonly`) |
| Bot only receives @mentions in groups | Wrong event permission | Switch from `im:message.group_at_msg:readonly` to `im:message.group_msg:readonly` |
| "Missing appId or appSecret" | Empty credentials | Re-enter App ID and App Secret in CodeMux config |
| Group creation fails | Missing permissions | Verify `im:chat` and `im:chat:create` scopes are approved |
| Bot can't update group name | Missing permissions | Verify `im:chat:update` or `im:chat:operate_as_owner` scope is approved |
| Bot menu clicks not working | Event not subscribed | Ensure `application.bot.menu_v6` event is subscribed in Event Configuration |
| Bot doesn't appear in contacts | App not published | Go to Version Management → create and publish a version |
| Messages truncated | Content exceeds 25KB | Normal behavior — long responses are truncated with a notice |
| Permission errors on startup | App not approved | Check version approval status in the matching Feishu or Lark developer console |
| `system busy` / `PingInterval` on startup | Platform mismatch or incomplete WS config response | Verify the CodeMux platform selector matches your tenant (`open.feishu.cn` vs `open.larksuite.com`) and **Use Long Connection** is enabled |
| Duplicate messages | Normal deduplication | Bot uses message ID deduplication (LRU, max 1000 IDs) — safe to ignore |

## Technical Details

- **SDK**: `@larksuiteoapi/node-sdk` (official Lark Node.js SDK)
- **Connection**: WebSocket (WSClient) — persistent connection from CodeMux to Feishu or Lark cloud
- **Message Format**: Interactive Cards with Markdown content
- **Persistence**: Group-session bindings saved to `~/.channels/feishu-bindings.json`
- **Rate Limiting**: TokenBucket — 5 burst capacity, 5 tokens/sec refill
