<div align="center">

# CodeMux

[English](./README.md) | **[简体中文](./README.zh-CN.md)** | [日本語](./README.ja.md) | [한국어](./README.ko.md)

**统一界面，驾驭每一个 AI 编程引擎。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*面向多种 AI 编程引擎的统一桌面与 Web 客户端 —— OpenCode、GitHub Copilot CLI 等，一个界面全部搞定。随时随地，从任意设备访问。*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - 多引擎 AI 编程界面" width="800" />

</div>

---

## 什么是 CodeMux？

AI 编程助手功能强大，但生态割裂。OpenCode、GitHub Copilot CLI、Claude Code 各自运行在独立的终端中，会话隔离、协议不同、没有统一的界面。

**CodeMux** 是一个多引擎网关，将它们全部整合到一起。它在协议层对接每个引擎，提供统一的桌面应用和 Web 界面来管理跨引擎的会话 —— 从任意设备、甚至通过互联网访问。

这不是又一个多模型聊天套壳。每个引擎保留完整的能力 —— 工具执行、文件编辑、Shell 访问、会话历史 —— CodeMux 只是为它们提供了一个共享的入口。

---

## 核心特性

| 类别 | 特性 | 描述 |
|------|------|------|
| **多引擎** | 统一网关 | 在单一界面中切换 OpenCode、Copilot CLI 等引擎 |
| | 协议级集成 | 直接 ACP (JSON-RPC/stdio) 和 HTTP+SSE 连接 —— 不是进程包装 |
| | 独立会话 | 每个引擎维护自己的会话、历史和能力 |
| **远程访问** | 任意设备访问 | 用手机、平板或任何浏览器访问你的编程引擎 |
| | 一键公网穿透 | Cloudflare Tunnel —— 无需端口转发、无需 VPN、无需修改防火墙 |
| | 局域网 + 二维码 | 二维码扫码即连，移动设备即刻接入 |
| **界面** | 实时流式传输 | 实时 Token 流式输出，工具调用可视化 |
| | 逐步执行展示 | 可展开的工具调用，显示文件 diff、Shell 输出等 |
| | 项目管理 | 按项目目录分组管理跨引擎会话 |
| **安全** | 设备授权 | 每个设备必须经过审批才能访问 |
| | JWT + 访问码 | 基于 Token 的认证，远程设备使用 6 位数访问码 |
| | 临时隧道 URL | 每次隧道重启时公网 URL 自动更换 |

---

## 支持的引擎

| 引擎 | 协议 | 状态 | 亮点 |
|------|------|------|------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 稳定 | 多供应商模型选择、完整会话管理、文件/Shell 工具 |
| **[GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)** | ACP (JSON-RPC/stdio) | ✅ 稳定 | 原生 ACP 集成、SQLite 会话历史、Copilot 完整智能体能力 |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 计划中 | 等待官方 ACP 协议支持 |

### 首个 Copilot CLI 开源图形界面

GitHub Copilot 是全球使用最广泛的 AI 编程工具。通过 **Copilot CLI**，GitHub 借助 [ACP 协议](https://github.com/anthropics/agent-control-protocol) 将智能体编程能力带入了终端。

**CodeMux 是首个 —— 也是目前唯一一个 —— 为 Copilot CLI 提供图形界面的开源项目。** 没有其他工具提供协议级 ACP 集成和完整 GUI。如果你使用 Copilot 并想要一个智能体编程的可视化界面，CodeMux 是唯一的开源选择。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - 逐步工具执行" width="700" />

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI（桌面端通过 Electron / Web 端通过浏览器）              │
│                          │                                      │
│              WebSocket (JSON-RPC)                               │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │    Gateway 服务器     │                           │
│              │   （引擎管理器）      │                           │
│              └───┬───────┬───────┬───┘                          │
│                  │       │       │                               │
│           ┌──────┘   ┌───┘   ┌───┘                              │
│           │          │       │                                   │
│     ┌─────┴─────┐ ┌──┴───┐ ┌─┴──────┐                          │
│     │ OpenCode  │ │Copilot│ │ Claude │                          │
│     │  适配器   │ │适配器 │ │ 适配器 │                          │
│     │(HTTP+SSE) │ │ (ACP) │ │ (ACP)  │                          │
│     └───────────┘ └──────┘ └────────┘                           │
│                                                                  │
│     统一类型系统：UnifiedPart, ToolPart, AgentMode               │
└─────────────────────────────────────────────────────────────────┘
```

所有引擎共享一套**标准化类型系统** —— 工具调用、文件操作、diff 和消息都映射为统一格式 (`UnifiedPart`)，UI 无需关心底层运行的是哪个引擎。

---

## 快速开始

### 方式一：桌面应用

下载适合你平台的最新版本：

- **macOS (Apple Silicon)**：`CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**：`CodeMux-x.x.x-x64.dmg`
- **Windows**：`CodeMux-x.x.x-setup.exe`

桌面应用内置了 Cloudflare Tunnel 和网关服务器。**OpenCode 和 Copilot CLI 需要单独安装**（见下文）。

> ⚠️ **macOS 用户注意**：应用未经代码签名。如果 macOS 提示"应用已损坏"，请运行：
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### 方式二：开发模式

```bash
# 克隆仓库
git clone https://github.com/realDuang/codemux.git
cd codemux

# 安装依赖
bun install

# 下载 cloudflared（用于远程访问）
bun run update:cloudflared

# 启动开发服务器（Electron + Vite HMR）
bun run dev
```

> **引擎依赖**：两个引擎均为外部依赖，需要单独安装并添加到 PATH：
> - **OpenCode**：从 [opencode.ai](https://opencode.ai) 安装 — `curl -fsSL https://opencode.ai/install.sh | bash`（Unix）或 `irm https://opencode.ai/install.ps1 | iex`（Windows）
> - **Copilot CLI**：单独安装 [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)
>
> CodeMux 启动时会自动检测已安装的引擎。

---

## 远程访问

### 局域网访问

1. 打开 CodeMux，进入 **远程访问** 设置
2. 在页面上找到你的机器 IP 地址
3. 从其他设备打开 `http://<你的IP>:5173`
4. 输入 6 位数访问码或扫描二维码

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - 远程访问" width="700" />

### 公网访问

通过 Cloudflare Tunnel 从任何地方访问：

1. 在远程访问区域开启 **"公网访问"**
2. 分享生成的 `*.trycloudflare.com` URL
3. 远程设备通过访问码认证

**无需端口转发。无需修改防火墙。无需 VPN。**

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
  │  引擎   │   引擎   │   引擎    │
  └─────────┴──────────┴───────────┘
```

### 设备管理

- **查看** 所有已连接设备及最后访问时间
- **重命名** 设备，方便识别
- **撤销** 单个设备或一键撤销所有设备的访问权限

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - 设备管理" width="700" />

---

## 安全

| 层级 | 保护措施 |
|------|----------|
| **设备授权** | 新设备需要通过 6 位数访问码审批 |
| **JWT Token** | 每个设备独立的 Token，安全存储 |
| **HTTPS** | 公网隧道通过 Cloudflare 自动启用 HTTPS |
| **临时 URL** | 隧道 URL 每次重启时自动更换 |

**最佳实践：**
- 不再使用的设备及时撤销访问权限
- 不需要时关闭公网隧道
- CodeMux 专为个人使用设计 —— 不适用于多用户场景

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面外壳 | Electron 33 |
| 构建系统 | electron-vite (Vite 5) |
| 前端 | SolidJS 1.8 + TypeScript 5 |
| 样式 | Tailwind CSS v4 |
| 引擎通信 | WebSocket + JSON-RPC, HTTP+SSE, ACP (stdio) |
| 打包 | electron-builder (DMG, NSIS) |
| 隧道 | Cloudflare Tunnel (cloudflared) |

---

## 开发

### 命令

```bash
bun run dev              # Electron + Vite HMR
bun run build            # 生产构建
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS 安装包
bun run typecheck        # 类型检查
bun run update:cloudflared  # 更新 Cloudflare Tunnel 二进制文件
```

### 项目结构

```
codemux/
├── electron/
│   ├── main/
│   │   ├── engines/          # 引擎适配器（OpenCode、Copilot、ACP 基类）
│   │   ├── gateway/          # WebSocket 服务器 + 引擎路由
│   │   └── services/         # 认证、设备存储、隧道、会话
│   └── preload/
├── src/                      # SolidJS 渲染层
│   ├── pages/                # Chat、Settings、Devices、Entry
│   ├── components/           # UI 组件 + 内容渲染器
│   ├── stores/               # 响应式状态（session、message、config）
│   ├── lib/                  # 网关客户端、认证、i18n、主题
│   └── types/                # 统一类型系统 + 工具映射
├── scripts/                  # 安装脚本、二进制更新器
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## 贡献

欢迎贡献！请遵循以下规范：

**代码风格**：TypeScript 严格模式、SolidJS 响应式模式、Tailwind 样式

**提交规范**：`feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**添加新引擎**：实现 `EngineAdapter`（参见 `electron/main/engines/engine-adapter.ts`），在 `src/types/tool-mapping.ts` 中添加工具名称映射，在 `electron/main/index.ts` 中注册。

---

## 许可证

[MIT](LICENSE)

---

## 链接

- [Issues 与功能请求](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) —— 支持的引擎
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) —— 支持的引擎

---

<div align="center">

**基于 [Electron](https://electronjs.org)、[SolidJS](https://solidjs.com) 构建，致力于 AI 辅助编程。**

</div>
