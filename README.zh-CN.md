<div align="center">

# CodeMux

[English](./README.md) | **[简体中文](./README.zh-CN.md)** | [日本語](./README.ja.md) | [한국어](./README.ko.md)

**首个开源的 GitHub Copilot CLI 图形界面。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*多引擎 AI 编程客户端，完整的 Agent 思维链可视化，零配置安全远程访问 —— 不只是又一个聊天封装。*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - 多引擎 AI 编程界面" width="800" />

</div>

---

## 为什么选择 CodeMux？

### 1. 首个 GitHub Copilot CLI 图形界面

GitHub Copilot 是全球使用最广泛的 AI 编程工具。**Copilot CLI** 将其完整的 Agent 能力带入终端 —— 但它没有图形界面。

**CodeMux 是首个 —— 也是目前唯一的 —— Copilot CLI 开源图形界面。** 它在协议层面连接（JSON-RPC over stdio），让你在可视化界面中获得 Copilot 完整的 Agent 编程体验。

### 2. 多引擎，而非多模型

这不是一个切换 API Key 的聊天封装。CodeMux 是一个**协议级网关** —— 每个引擎运行在自己的运行时中，会话、工具执行和能力都完整保留。

在同一个界面中切换引擎，每个引擎都保持完整能力 —— 文件编辑、Shell 访问、会话历史、项目上下文 —— CodeMux 只是为它们提供了一个统一的入口。

| 引擎 | 协议 | 状态 |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 稳定 |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | JSON-RPC/stdio | ✅ 稳定 |
| **[Claude Code](https://claude.ai/code)** | SDK (stdio) | ✅ 稳定 |

### 3. Agent 思维链可视化

每个 Agent 操作都渲染为可展开的步骤 —— 文件 diff、Shell 命令、搜索结果、工具调用 —— 让你清楚地看到 Agent 在做什么以及为什么这样做，而不仅仅是最终答案。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - 逐步 Agent 可视化" width="700" />

### 4. 零配置安全远程访问

从任何设备访问你的编程 Agent —— 手机、平板或另一台电脑 —— 无需修改任何配置文件。

- **局域网**：自动检测 IP + 二维码，几秒内即可就绪
- **公网**：一键 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) —— 无需端口转发、无需 VPN、无需防火墙更改
- **内置安全机制**：设备授权、JWT 令牌、通过 Cloudflare 的 HTTPS、每次重启时轮换的临时隧道 URL

### 5. IM 机器人渠道

直接在你常用的即时通讯应用中使用 AI 编程 Agent —— 无需打开浏览器。CodeMux 以机器人身份接入各平台，通过网关将聊天消息桥接到任意引擎。

#### 支持平台

| 平台 | 事件接收 | 流式输出 | 创建群组 | 富文本内容 |
|------|---------|---------|---------|-----------|
| [飞书](https://open.feishu.cn/) | WebSocket（长连接） | ✅ 编辑更新 | ✅ 自动建群 | 互动卡片 |
| [钉钉](https://open.dingtalk.com/) | Stream 模式（WS） | ✅ AI 卡片 | ✅ 场景群 | ActionCard / Markdown |
| [Telegram](https://core.telegram.org/bots/api) | Webhook / 长轮询 | ✅ sendMessageDraft | ❌ 仅私聊 | MarkdownV2 + 内联键盘 |
| [企业微信](https://developer.work.weixin.qq.com/) | HTTP 回调（AES XML） | ❌ 批量模式 | ✅ 应用群聊 | Markdown / 模板卡片 |
| [Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) | Bot Framework HTTP | ✅ 编辑更新 | ❌ 仅私聊 | Adaptive Cards v1.5 |

#### 通用功能

- **私聊入口**：与机器人私聊选择项目和会话
- **斜杠命令**：`/cancel`、`/status`、`/mode`、`/model`、`/history`、`/help`
- **流式响应**：AI 实时输出，根据平台能力自动选择更新策略
- **工具摘要**：完成时附带操作统计（如 `Shell(2), Edit(1)`）
- **自动审批权限**：引擎权限请求自动批准

#### 会话模型

- **一群一会话**（飞书、钉钉、企业微信）：每个群聊对应一个 CodeMux 会话。私聊选择项目 → 自动创建群聊。
- **私聊直连**（Telegram、Teams）：在私聊中直接交互，使用临时会话（2 小时 TTL）。群聊中 @机器人 交互。

#### 配置方式

每个平台需要在开发者门户创建机器人/应用，然后在 CodeMux 设置 → 渠道中配置凭证：

| 平台 | 需要的凭证 | 开发者门户 |
|------|-----------|-----------|
| 飞书 | App ID、App Secret | [open.feishu.cn](https://open.feishu.cn/) |
| 钉钉 | App Key、App Secret、Robot Code | [open.dingtalk.com](https://open.dingtalk.com/) |
| Telegram | Bot Token（来自 @BotFather） | [core.telegram.org](https://core.telegram.org/bots) |
| 企业微信 | 企业 ID、应用密钥、Agent ID、回调 Token、加密密钥 | [developer.work.weixin.qq.com](https://developer.work.weixin.qq.com/) |
| Teams | Microsoft App ID、应用密码 | [Azure Portal](https://portal.azure.com/) + [Teams 开发者门户](https://dev.teams.microsoft.com/) |

---

## 快速开始

### 方式 1：桌面应用

**macOS（推荐 — 通过 Homebrew）：**

```bash
brew tap realDuang/codemux
brew install --cask codemux
```

**手动下载：**

- **macOS (Apple Silicon)**：`CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**：`CodeMux-x.x.x-x64.dmg`
- **Windows**：`CodeMux-x.x.x-setup.exe`

桌面应用内置了 Cloudflare Tunnel 二进制文件和网关服务器。**OpenCode、Copilot CLI 和 Claude Code 需要单独安装**（见下文）。

> ⚠️ **macOS 用户（手动下载）**：应用未进行代码签名。如果 macOS 提示"应用已损坏"，请运行：
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### 方式 2：开发模式

```bash
# 克隆仓库
git clone https://github.com/realDuang/codemux.git
cd codemux

# 安装依赖
bun install

# 下载 cloudflared 二进制文件（用于远程访问）
bun run update:cloudflared

# 启动开发服务器（Electron + Vite HMR）
bun run dev
```

> **引擎前置条件**：所有引擎都是外部依赖，需要安装并添加到 PATH 中：
> - **OpenCode**：从 [opencode.ai](https://opencode.ai) 安装 —— `curl -fsSL https://opencode.ai/install.sh | bash`（Unix）或 `irm https://opencode.ai/install.ps1 | iex`（Windows）
> - **Copilot CLI**：单独安装 [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)
> - **Claude Code**：通过 `npm install -g @anthropic-ai/claude-code` 安装，并设置 `ANTHROPIC_API_KEY`
>
> CodeMux 启动时会自动检测已安装的引擎。

---

## 远程访问

### 局域网访问

1. 打开 CodeMux，进入设置中的**远程访问**
2. 在页面上找到你机器的 IP 地址
3. 从另一台设备打开 `http://<your-ip>:5173`
4. 输入 6 位访问码或扫描二维码

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - 远程访问" width="700" />

### 公网访问

通过 Cloudflare Tunnel 从任何地方访问 —— **无需端口转发、无需防火墙更改、无需 VPN：**

1. 在远程访问部分开启**"公网访问"**
2. 分享生成的 `*.trycloudflare.com` URL
3. 远程设备使用访问码进行认证

```
你的手机/平板
       ↓
https://xyz.trycloudflare.com
       ↓
  Cloudflare 网络
       ↓
  你的工作站（CodeMux 网关）
       ↓
  ┌─────────┬──────────┬───────────┐
  │OpenCode │ Copilot  │  Claude   │
  │ Engine  │  Engine  │  Engine   │
  └─────────┴──────────┴───────────┘
```

### 安全与设备管理

| 层级 | 保护措施 |
|-------|------------|
| **设备授权** | 新设备需要通过 6 位验证码审批 |
| **JWT 令牌** | 按设备存储的安全令牌 |
| **HTTPS** | 公网隧道通过 Cloudflare 自动使用 HTTPS |
| **临时 URL** | 隧道 URL 每次重启时更换 |

在设备管理页面管理已连接的设备 —— 查看最后访问时间、重命名以便识别，或按设备撤销访问权限。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - 设备管理" width="700" />

> CodeMux 专为个人使用设计。请撤销不再使用的设备，并在不需要时关闭公网隧道。

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI（桌面端通过 Electron / 网页端通过浏览器）              │
│                          │                                      │
│              WebSocket (JSON-RPC)                               │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │      网关服务器        │                          │
│              │    （引擎管理器）       │                          │
│              └───┬───────┬───────┬───┘                          │
│                  │       │       │                              │
│            ┌─────┘    ┌──┘      ┌┘                              │
│            │          │         │                               │
│      ┌─────┴─────┐ ┌──┴────┐ ┌──┴─────┐                         │
│      │ OpenCode  │ │Copilot│ │ Claude │                         │
│      │  适配器   │ │ 适配器│ │ 适配器  │                         │
│      │(HTTP+SSE) │ │ (ACP) │ │ (SDK)  │                         │
│      └───────────┘ └───────┘ └────────┘                         │
│                                                                 │
│     统一类型系统：UnifiedPart, ToolPart, AgentMode                │
└─────────────────────────────────────────────────────────────────┘
```

所有引擎共享一个**标准化类型系统** —— 工具调用、文件操作、diff 和消息都映射到统一格式（`UnifiedPart`），因此 UI 无需关心当前运行的是哪个引擎。

---

## 开发

### 命令

```bash
bun run dev              # Electron + Vite HMR
bun run build            # 生产构建
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS 安装程序
bun run typecheck        # 类型检查
bun run update:cloudflared  # 更新 Cloudflare Tunnel 二进制文件
```

### 项目结构

```
codemux/
├── electron/
│   ├── main/
│   │   ├── engines/          # 引擎适配器（OpenCode、Copilot、Claude Code）
│   │   ├── gateway/          # WebSocket 服务器 + 引擎路由
│   │   ├── channels/         # IM 机器人渠道（飞书、钉钉、Telegram、企业微信、Teams）
│   │   └── services/         # 认证、设备存储、隧道、会话
│   └── preload/
├── src/                      # SolidJS 渲染层
│   ├── pages/                # Chat、Settings、Devices、Entry
│   ├── components/           # UI 组件 + 内容渲染器
│   ├── stores/               # 响应式状态（session、message、config）
│   ├── lib/                  # 网关客户端、认证、国际化、主题
│   └── types/                # 统一类型系统 + 工具映射
├── scripts/                  # 安装脚本、二进制文件更新器
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## 贡献

欢迎贡献！请遵循以下规范：

**代码风格**：TypeScript 严格模式，SolidJS 响应式模式，使用 Tailwind 进行样式编写

**提交规范**：`feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**添加新引擎**：实现 `EngineAdapter`（参见 `electron/main/engines/engine-adapter.ts`），在 `src/types/tool-mapping.ts` 中添加工具名称映射，然后在 `electron/main/index.ts` 中注册。

---

## 许可证

[MIT](LICENSE)

---

## 链接

- [问题反馈与功能建议](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — 支持的引擎
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 支持的引擎
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 支持的引擎
- [飞书开放平台](https://open.feishu.cn/) — 飞书机器人渠道
- [钉钉开放平台](https://open.dingtalk.com/) — 钉钉机器人渠道
- [Telegram Bot API](https://core.telegram.org/bots/api) — Telegram 机器人渠道
- [企业微信开发者中心](https://developer.work.weixin.qq.com/) — 企业微信机器人渠道
- [Microsoft Teams 平台](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) — Teams 机器人渠道

---

<div align="center">

**基于 [Electron](https://electronjs.org)、[SolidJS](https://solidjs.com) 构建，源于对 AI 辅助编程的热爱。**

</div>
