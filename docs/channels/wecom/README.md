# WeCom (企业微信) Channel Setup

Connect CodeMux to WeCom (WeChat Work) using HTTP callbacks. Requires a Cloudflare Tunnel for webhook message delivery.

## Overview

| Feature | Support |
|---------|---------|
| Connection | HTTP Callback (AES-encrypted XML) — requires tunnel |
| Streaming | ❌ Batch mode only (messages cannot be edited) |
| Rich Content | ✅ Markdown |
| Interaction Mode | P2P direct chat (user ↔ bot) |
| Max Message Size | 2,048 bytes |
| Rate Limit | 30 messages/min per user |

## Prerequisites

- A WeCom organization account (企业微信)
- Admin access to the [WeCom Admin Console](https://work.weixin.qq.com/)
- A [Cloudflare Tunnel](../../README.md) configured and running

## Step 1: Create a WeCom App

1. Log in to [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#apps)
2. Go to **Application Management** (应用管理) → **Create Application** (自建 → 创建应用)
3. Fill in:
   - **App Name**: e.g., "CodeMux"
   - **App Logo**: Upload an icon
   - **Visible Range** (可见范围): Select which departments/users can use the app
4. After creation, note:
   - **Agent ID** (AgentId): Shown on the app detail page (a number)

## Step 2: Get Credentials

### Corp ID (企业 ID)

1. Go to **My Enterprise** (我的企业) → **Enterprise Information** (企业信息)
2. Copy the **Corp ID** at the bottom of the page

### App Secret (应用 Secret)

1. Go to your app's detail page
2. Click **View** next to Secret (查看 Secret)
3. The secret will be sent to your WeCom app — copy it

## Step 3: Configure Callback URL

This is the critical step — WeCom needs to reach your CodeMux instance via HTTP.

1. In the app settings, go to **API Receiving** (接收消息)
2. Click **Set API Receiving** (设置API接收)
3. Fill in:

| Field | Value | Notes |
|-------|-------|-------|
| **URL** | `https://your-tunnel-domain/webhook/wecom` | Must be HTTPS. Use your Cloudflare Tunnel domain |
| **Token** | (auto-generated or custom) | 32-character verification token. Click "Random Generate" or enter your own |
| **EncodingAESKey** | (auto-generated) | 43-character Base64 string. Click "Random Generate" (随机获取) |

4. **Before clicking Save**: Make sure your Cloudflare Tunnel is running and CodeMux is started with the WeCom channel configured (Step 5). WeCom will send a verification request to your URL when you save.

> 💡 **Tip**: If you need to generate the AES key manually:
> ```bash
> openssl rand -base64 32
> ```
> This produces a 44-character string — use the first 43 characters.

## Step 4: Set Enterprise Trusted IP (企业可信IP)

WeCom requires all API calls (sending messages, etc.) to originate from whitelisted IPs.

1. Go to your app's detail page
2. Scroll to **Enterprise Trusted IP** (企业可信IP)
3. Add the **public IP** of your server/machine

> ⚠️ **Home/dynamic IP users**: Your public IP may change periodically. If the bot suddenly stops replying, check if your IP has changed and update the whitelist.
>
> To find your current public IP, run: `curl https://ifconfig.me`

## Step 5: Set Permissions

The app should have these permissions (usually granted by default for custom apps):

| Permission | Purpose |
|-----------|---------|
| Send messages (发送应用消息) | Send replies to users |
| Receive messages (接收成员消息) | Receive user messages via callback |
| Message recall (消息撤回) | Delete bot messages |

## Step 6: Configure in CodeMux

1. **Important**: Set up and start Cloudflare Tunnel first
2. Open CodeMux → go to the remote access page → **Channels** tab
3. Click **Configure** on the WeCom card
4. Enter:

| Field | Value | From |
|-------|-------|------|
| **Corp ID** | Your enterprise ID | Step 2 |
| **Corp Secret** | Application secret | Step 2 |
| **Agent ID** | Application AgentId (number) | Step 1 |
| **Callback Token** | Verification token | Step 3 |
| **Callback Encoding AES Key** | 43-char Base64 key | Step 3 |

5. Click **Save** — the channel will start automatically
6. Now go back to WeCom Admin Console and save the callback URL configuration (Step 3, point 4)

> ⚠️ **Important**: Make sure there are no leading/trailing spaces in the credential fields. Whitespace in Corp ID, Token, or EncodingAESKey will cause verification failures.

## Usage

### Getting Started

1. Open WeCom and find the app in your application list
2. Send any message to the app
3. The bot shows available projects — select one by number
4. Choose to create a new session or use an existing one
5. Once a session is active, all messages are routed to the AI engine directly in the chat

### Batch Mode (No Streaming)

WeCom **does not support editing sent messages**. Because of this:

1. While the AI is processing, you'll see a "🤔 思考中..." indicator
2. The bot waits until the AI finishes completely
3. The full response is sent as a single Markdown message
4. For long responses, the message may be truncated at 2,048 bytes with a "...（内容已截断，请在 CodeMux 中查看完整回复）" notice

### Session Management

- Sessions are managed in the P2P chat (user ↔ bot direct messages)
- Use `/project` to switch project, `/new` to create a new session, `/switch` to pick an existing one
- Use `/help` to see all available commands
- Session state is persisted and survives app restarts

## Limitations

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| **No message editing** | No streaming — responses sent in full | Use CodeMux web UI for real-time streaming |
| **2,048 byte limit** | Long responses truncated | Check full response in CodeMux web/desktop app |
| **30 msg/min rate limit** | Rapid interactions may be throttled | CodeMux includes rate limiting to avoid quota exhaustion |
| **Text messages only** | Cannot send images or files via WeCom channel | View file content in CodeMux web UI |
| **HTTPS callback required** | Must have a public HTTPS endpoint | Use Cloudflare Tunnel |

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| "URL verification failed" | Tunnel not running or URL wrong | Start Cloudflare Tunnel, verify URL matches exactly |
| "URL verification failed" (signature OK) | Whitespace in Corp ID / AES key | Re-copy credentials without leading/trailing spaces |
| Messages not received | Token/AES key mismatch | Re-copy Token and EncodingAESKey from WeCom admin — they must match exactly |
| "Invalid corp ID" | Wrong Corp ID | Find it in **My Enterprise** → **Enterprise Information** |
| "not allow to access from your ip" (60020) | Server IP not whitelisted | Add your public IP to **Enterprise Trusted IP** in app settings |
| "Callback IP not whitelisted" | WeCom requires IP whitelist | Same as above — add IP to Enterprise Trusted IP |
| Messages truncated | Normal — 2KB limit | Use CodeMux web UI for long responses |
| Bot responds slowly | Batch mode + AI processing time | Normal — WeCom shows response only after AI completes |
| Tunnel returns error 1033 | DNS not pointing to tunnel | Run `cloudflared tunnel route dns <tunnel-id> <hostname>` to create CNAME |

## Technical Details

- **Callback Format**: AES-256-CBC encrypted XML, decrypted using EncodingAESKey
- **Webhook Endpoint**: `/webhook/wecom` (POST)
- **Authentication**: Token verification + AES message decryption
- **Message Format**: Markdown text (no ActionCards in current implementation)
- **Group API**: Not used — WeCom requires ≥2 members for group chats, so P2P mode is used instead
- **Persistence**: Session state saved to Electron `userData/channels/wecom-bindings.json`
- **Rate Limiting**: TokenBucket — 5 burst capacity, 0.5 tokens/sec (30/min)
