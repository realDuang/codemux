# Microsoft Teams Channel Setup

Connect CodeMux to Microsoft Teams using the Bot Framework. Requires a Cloudflare Tunnel for webhook message delivery.

## Overview

| Feature | Support |
|---------|---------|
| Connection | Bot Framework HTTP — requires tunnel |
| Streaming | ✅ Edit-in-place (progressive message update) |
| Rich Content | ✅ Adaptive Cards v1.5 |
| Group Creation | ❌ P2P only (bot can be added to existing teams/channels) |
| Max Message Size | ~80,000 bytes |
| Rate Limit | 1 message/sec (conservative) |

## Prerequisites

- An [Azure](https://portal.azure.com/) account
- Access to [Microsoft Teams](https://teams.microsoft.com/)
- A [Cloudflare Tunnel](../../README.md) configured and running

## Step 1: Create an Azure AD App Registration

1. Go to [Azure Portal](https://portal.azure.com/) → **Azure Active Directory** → **App registrations**
2. Click **New registration**
3. Fill in:
   - **Name**: "CodeMux Bot"
   - **Supported account types**: **Single tenant** (recommended for enterprise/internal use)
     > Choose **Multi-tenant** only if you need the bot to work across multiple Azure AD organizations
4. Click **Register**
5. Copy:
   - **Application (client) ID** → this is your **Microsoft App ID**
   - **Directory (tenant) ID** → this is your **Tenant ID**

## Step 2: Create a Client Secret

1. In the app registration, go to **Certificates & secrets**
2. Click **New client secret**
3. Add a description (e.g., "CodeMux Bot Secret") and select an expiry period
4. Click **Add**
5. **Immediately copy the Value** — this is your **Microsoft App Password**
   > ⚠️ You can only see the secret value once. If you lose it, you must create a new one.

## Step 3: Create an Azure Bot Resource

1. Go to [Azure Portal](https://portal.azure.com/) → search for **Azure Bot** → click **Create**
2. Fill in:

| Field | Value |
|-------|-------|
| **Bot handle** | A unique identifier (e.g., `codemux-bot`) |
| **Pricing tier** | F0 (free) |
| **Microsoft App ID** | Select "Use existing app registration" → enter the App ID from Step 1 |
| **App type** | Single Tenant (or Multi-tenant, matching Step 1) |
| **App tenant ID** | Your Tenant ID from Step 1 |

3. Click **Review + create** → **Create**
4. After deployment, go to the bot resource → **Configuration**
5. Set **Messaging endpoint** to:
   ```
   https://your-tunnel-domain/api/messages
   ```
6. Go to **Channels** → ensure **Microsoft Teams** is listed and enabled

## Step 4: Install the Bot in Teams

### Option A: Use Auto-Generated App Package (Recommended)

CodeMux automatically generates a Teams app package when the channel starts:

1. Start the Teams channel in CodeMux (Step 5 below)
2. Find the generated package at:
   - **Windows**: `%APPDATA%\codemux\channels\teams-app.zip`
   - **macOS**: `~/Library/Application Support/codemux/channels/teams-app.zip`
3. Upload to Teams:
   - **Admin install**: [Teams Admin Center](https://admin.teams.microsoft.com/) → **Teams apps** → **Manage apps** → **Upload new app**
   - **Sideload** (for testing): Teams → Apps → **Manage your apps** → **Upload a custom app**

### Option B: Use Teams Developer Portal

1. Go to [Teams Developer Portal](https://dev.teams.microsoft.com/) → **Apps** → **Import app**
2. Upload the auto-generated zip file
3. Or create a new app manually:
   - Add a **Bot** with your Microsoft App ID
   - Set the messaging endpoint to your tunnel URL + `/api/messages`
   - Set scopes: Personal, Team, Group Chat

## Step 5: Configure in CodeMux

1. **Important**: Set up and start Cloudflare Tunnel first
2. Open CodeMux → go to the remote access page → **Channels** tab
3. Click **Configure** on the Teams card
4. Enter:

| Field | Value | From |
|-------|-------|------|
| **Microsoft App ID** | Application (client) ID | Step 1 |
| **Microsoft App Password** | Client secret value | Step 2 |
| **Tenant ID** | Directory (tenant) ID | Step 1 (required for Single Tenant) |

5. Click **Save** — the channel will start automatically

## Usage

### Getting Started

1. Open Microsoft Teams
2. Find the bot in your apps or search for it
3. Start a **1:1 chat** with the bot
4. Send any message to begin
5. The bot shows available projects — select one
6. Interact with the AI engine directly in the chat

### P2P Chat (Primary Mode)

- Open a private chat with the bot
- Send messages directly — bot responds with rich Adaptive Cards
- Full streaming support: responses build up in real-time

### Team / Channel Chat

- Add the bot to a team or channel
- @mention the bot: `@CodeMux Bot your question here`
- Bot responds in the thread

### Streaming

Teams supports **edit-in-place streaming**: the bot sends a message and progressively updates it as the AI generates output. The update throttle is 1.5 seconds by default.

### Adaptive Cards

Teams responses use Adaptive Cards v1.5, which include:
- **Markdown text** with headers, bold, lists, code blocks
- **Interactive buttons** for permission approvals and question prompts
- **Structured layouts** with separators and containers

## Single Tenant vs Multi-Tenant

| Aspect | Single Tenant | Multi-Tenant |
|--------|--------------|-------------|
| **Scope** | Your Azure AD organization only | Any Azure AD organization |
| **Tenant ID** | ✅ Required in CodeMux config | ❌ Leave empty |
| **Token Authority** | `login.microsoftonline.com/{tenantId}` | `login.microsoftonline.com/botframework.com` |
| **Best For** | Enterprise internal bots | Publicly distributed bots |

**Recommendation**: Use **Single Tenant** for most cases. Only use Multi-tenant if you need the bot to work across different Azure AD organizations.

> ⚠️ If you get "Failed to fetch token" errors, double-check that your tenant type (Single vs Multi) matches what you selected in the Azure AD app registration.

## Troubleshooting

| Problem | Possible Cause | Solution |
|---------|---------------|----------|
| "Unauthorized" errors | Wrong App ID or Password | Verify credentials match Azure AD registration |
| "Failed to fetch token" | Tenant ID mismatch | For Single Tenant: set Tenant ID. For Multi-tenant: leave empty |
| Bot doesn't respond | Messaging endpoint wrong | Verify endpoint is `https://your-domain/api/messages` in Azure Bot config |
| App package not generated | Channel not started | Start the Teams channel first, then check the output path |
| "Token validation failed" | Clock skew or expired secret | Re-generate client secret in Azure Portal |
| Bot not visible in Teams | App not installed | Upload the app package via Teams Admin Center or sideload |
| Messages not received | Tunnel not running | Start Cloudflare Tunnel before interacting with the bot |
| Adaptive Cards not rendering | Normal for some clients | Some Teams clients (mobile, old versions) may render cards differently |
| Slow responses | First message latency | Normal — first interaction may take 3-5 seconds for auth token negotiation |

## Technical Details

- **Protocol**: Bot Framework HTTP (REST API v3)
- **Webhook Endpoint**: `/api/messages` (POST)
- **Authentication**: Azure AD OAuth2 client credentials (JWT token validation)
- **Token Refresh**: Auto-refresh on expiry (~1 hour lifetime)
- **Message Format**: Adaptive Cards v1.5 with Markdown content
- **App Package**: Auto-generated at `{userData}/channels/teams-app.zip` (manifest v1.17 + icons)
- **Rate Limiting**: TokenBucket — 5 burst capacity, 1 token/sec refill
- **Dev Mode**: Set `skipAuth: true` to disable JWT validation (local testing only, **never in production**)
