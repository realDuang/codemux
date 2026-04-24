# DingTalk (钉钉) Channel Setup

Connect CodeMux to DingTalk using Stream mode — no public URL or Cloudflare Tunnel required.

## Overview

| Feature | Support |
|---------|---------|
| Connection | Stream mode (WebSocket) — no tunnel needed |
| Streaming | ✅ AI Card (progressive update) |
| Rich Content | ✅ ActionCard / Markdown |
| Group Creation | ✅ Scene groups (场景群) |
| Max Message Size | 20,000 bytes |
| Rate Limit | ~20 messages/min per robot |

## Prerequisites

- A DingTalk organization account
- Admin access to the [DingTalk Open Platform](https://open.dingtalk.com/)

## Step 1: Create a DingTalk App

1. Go to [DingTalk Open Platform](https://open.dingtalk.com/) and log in
2. Navigate to **Application Development** (应用开发) → **Enterprise Internal Application** (企业内部应用) → **Create Application** (创建应用)
3. Select **Bot** (机器人) as the application type
4. Fill in:
   - **App Name**: e.g., "CodeMux"
   - **App Description**: e.g., "AI coding assistant"
5. After creation, go to **Credentials & Basic Info** (凭证与基础信息)
6. Copy the **AppKey** and **AppSecret**

## Step 2: Configure Robot

1. In the app dashboard, go to **Robot Configuration** (机器人配置)
2. Enable the robot and set:
   - **Robot Name**: Display name in chats
   - **Robot Avatar**: Upload an icon
3. Copy the **Robot Code** (robotCode) from this page
4. Under **Message Receiving Mode** (消息接收模式), select **Stream Mode** (Stream 模式)
   > Stream mode uses WebSocket — no public webhook URL required. CodeMux connects outbound to DingTalk's servers.

## Step 3: Set Permissions

Go to **Permission Management** (权限管理) and request:

| Permission | Purpose | Required |
|-----------|---------|----------|
| `qyapi_robot_sendmsg` | Send robot messages | ✅ Yes |
| `qyapi_chat_manage` | Manage group chats | ✅ Yes (for scene group creation) |

## Step 4: Publish the App

1. Go to **Version Management** → create a new version
2. Set the visibility scope (departments/users)
3. Submit for internal review (usually auto-approved)

## Step 5: Configure in CodeMux

1. Open CodeMux → go to the remote access page → **Channels** tab
2. Click **Configure** on the DingTalk card
3. Enter:
   - **App Key**: From Step 1
   - **App Secret**: From Step 1
   - **Robot Code**: From Step 2
4. Click **Save** — the channel will start automatically

## Usage

### Getting Started

1. Open DingTalk and search for your bot name
2. Send any message to the bot in a P2P chat
3. The bot shows available projects — select one
4. Choose to create a new session or use an existing one
5. A **scene group** (场景群) is automatically created for the session
6. All messages in that group are routed to the AI engine

### Interaction Flow

```
P2P Chat (Entry Point)
  ├─ /project → Show project list (reply with a number to switch)
  ├─ /new → Create a new session in the current project (auto-creates a scene group)
  ├─ /switch → Show existing sessions for the current project
  └─ /help → Show all commands

Group Chat (Session)
  ├─ Send message → AI engine processes and responds
  ├─ /cancel → Stop current request
  ├─ /status → Show current session info
  ├─ /mode <agent|plan|build> → Switch agent mode
  ├─ /model [list|<id>] → List or switch model
  ├─ /history → View recent messages
  └─ /help → Show all commands
```

### Streaming Behavior

DingTalk robot messages **cannot be edited after sending**. CodeMux works around this:

1. While the AI is thinking, a "🤔 思考中..." indicator is shown
2. Partial updates are buffered and throttled (default: 1.5s interval)
3. When the AI finishes, the complete response is sent as a rich **ActionCard**

The ActionCard includes:
- Full Markdown-formatted response
- Tool execution summary (e.g., `Shell(2), Edit(1)`)

### Session ↔ Group Mapping

- Each CodeMux session maps to one DingTalk scene group
- Group name format: `[ProjectName] SessionTitle`
- Bindings are persisted to disk and survive app restarts

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| Bot doesn't receive messages | Wrong message receiving mode | Ensure **Stream Mode** is selected in robot config |
| "Missing appKey or appSecret" | Empty credentials | Re-enter credentials in CodeMux config |
| Group creation fails | Missing permissions | Verify `qyapi_chat_manage` is granted |
| Messages truncated | Content exceeds 20KB | Normal — long responses are truncated with a notice |
| Rate limit errors | Sending too fast | DingTalk limits robots to ~20 msg/min. Increase `streamingThrottleMs` if needed |
| Token fetch failure | Invalid credentials | Verify AppKey and AppSecret are correct |
| Bot doesn't appear | App not published | Create and publish a version in the developer portal |

## Technical Details

- **Authentication**: OAuth2 client credentials (`https://api.dingtalk.com/v1.0/oauth2/accessToken`)
- **Token Refresh**: Auto-refresh every 2 hours
- **Message Format**: ActionCard (Markdown), plain text
- **Group API**: Scene group creation via `POST /v1.0/im/interconnections/groups`
- **Persistence**: Group bindings saved to `~/.channels/dingtalk-bindings.json`
- **Rate Limiting**: TokenBucket — 5 burst capacity, ~0.33 tokens/sec (20/min)
