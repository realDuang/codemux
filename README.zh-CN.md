<div align="center">

# OpenCode Remote

[English](./README.md) | **[简体中文](./README.zh-CN.md)** | [日本語](./README.ja.md) | [한국어](./README.ko.md)

**随时随地，从任意设备访问 OpenCode**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.1.15+-green.svg)](https://opencode.ai)

<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/logo.png" alt="OpenCode Remote" width="120" />

*在高性能工作站上运行 AI 编程助手，通过平板、手机或任何浏览器远程访问——甚至跨越互联网。*

<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/main-chat.jpg" alt="主聊天界面" width="800" />

</div>

---

## 为什么选择 OpenCode Remote？

像 OpenCode 这样的 AI 编程助手需要运行在以下条件的机器上：
- 能够访问你的代码库和开发环境
- 正确配置的 API 密钥
- 足够的计算能力

但如果你想**躺在沙发上用手机**、**用 iPad 结对编程**，或者**从世界任何地方访问你的开发机器**呢？

**OpenCode Remote** 提供了一个网页界面，让你可以从任何带浏览器的设备访问 OpenCode。

### 核心特性

| 特性 | 描述 |
|------|------|
| **任意终端远程访问** | 通过简洁的 Web UI，从手机、平板、笔记本电脑等任意设备访问 OpenCode |
| **一键公网穿透** | 使用 Cloudflare Tunnel 一键开启互联网访问——无需端口转发或 VPN |
| **局域网访问** | 局域网内的任何设备可即时访问 |
| **二维码连接** | 扫码即可从移动设备连接——无需手动输入 URL |
| **默认安全** | 每次会话使用随机 6 位数访问码 |
| **实时流式传输** | 通过 Server-Sent Events 实现消息实时推送 |
| **完整功能** | 所有 OpenCode 功能都可通过 Web UI 无缝使用 |

<div align="center">
<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/chat-steps.jpg" alt="聊天步骤" width="700" />

*AI 助手支持步骤化执行和深色模式*
</div>

---

## 快速开始

### 方式一：桌面应用（推荐）

下载适合你平台的最新版本：

- **macOS (Apple Silicon)**: `OpenCode Remote-x.x.x-arm64.dmg`
- **macOS (Intel)**: `OpenCode Remote-x.x.x-x64.dmg`
- **Windows**: `OpenCode Remote-x.x.x-setup.exe`

桌面应用内置了所有依赖——无需额外安装。

> ⚠️ **macOS 用户注意**：应用未经代码签名，macOS 可能提示"应用已损坏"。请运行以下命令修复：
>
> ```bash
> xattr -cr /Applications/OpenCode\ Remote.app
> ```

### 方式二：开发模式

```bash
# 克隆仓库
git clone https://github.com/realDuang/opencode-remote.git
cd opencode-remote

# 安装依赖
bun install

# 下载内置二进制文件
bun run update:opencode
bun run update:cloudflared

# 启动开发模式
bun run dev
```

---

## 远程访问指南

### 方式一：局域网访问（同一网络）

从局域网内的任意设备访问：

1. 找到你的机器 IP 地址（在远程访问页面显示）
2. 从其他设备打开 `http://<你的IP>:5174`
3. 输入 6 位数访问码

**或者扫描远程访问页面上显示的二维码。**

<div align="center">
<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/remote-access.jpg" alt="远程访问" width="700" />
</div>

### 方式二：公网访问

通过 Cloudflare Tunnel 从世界任何地方访问：

1. 安装 `cloudflared`（运行 `bun run setup` 获取引导安装）
2. 在 Web UI 中进入 **设置** → **远程访问**
3. 开启 **"公网访问"** 开关
4. 分享生成的 `*.trycloudflare.com` URL

**无需端口转发、无需修改防火墙、无需 VPN。**

```
┌──────────────────────────────────────────────────────────┐
│                     你的手机/平板                         │
│                          ↓                                │
│              https://xyz.trycloudflare.com                │
│                          ↓                                │
│                   Cloudflare 网络                         │
│                          ↓                                │
│               你的工作站 (OpenCode)                       │
└──────────────────────────────────────────────────────────┘
```

---

## 使用场景

### 随处工作
在高性能台式机上运行 OpenCode，从咖啡店的笔记本电脑控制它。

### 移动编程助手
在用手机查看代码或在白板上讨论时获得 AI 帮助。

### 结对编程
将公网 URL 分享给同事，实现实时协作。

### 家庭服务器
在家庭服务器上运行，从家中任何设备访问。

---

## 安全性

OpenCode Remote 使用多层安全机制：

| 层级 | 保护措施 |
|------|----------|
| **访问码** | 每次会话需要随机 6 位数访问码 |
| **Token 认证** | 登录后将类 JWT 令牌存储在 localStorage |
| **HTTPS** | 公网隧道通过 Cloudflare 自动使用 HTTPS |
| **临时 URL** | 每次启动隧道时公网 URL 都会变化 |

**最佳实践：**
- 不要公开分享你的访问码
- 不使用时关闭公网隧道
- 仅供个人使用——不适用于多用户场景

---

## 开发

### 命令

```bash
# 启动所有服务（OpenCode 服务器 + Web UI）
bun run start

# 开发模式（仅 Web UI，需手动启动 OpenCode 服务器）
bun run dev

# 安装可选依赖（cloudflared 等）
bun run setup

# 生产构建
bun run build

# 类型检查
bunx tsc --noEmit
```

### 项目结构

```
opencode-remote/
├── src/
│   ├── pages/           # 页面组件 (Chat, Login, Settings, RemoteAccess)
│   ├── components/      # UI 组件
│   ├── lib/             # 核心库 (API 客户端, 认证, 国际化)
│   ├── stores/          # 状态管理
│   └── types/           # TypeScript 类型定义
├── scripts/
│   ├── start.ts         # 启动脚本
│   └── setup.ts         # 依赖安装脚本
└── vite.config.ts       # Vite 配置（含认证中间件）
```

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | SolidJS |
| 构建工具 | Vite |
| 样式 | Tailwind CSS |
| 语言 | TypeScript |
| 包管理器 | Bun |
| 隧道 | Cloudflare Tunnel |

---

## 故障排除

### OpenCode CLI 未找到

```bash
# 运行安装脚本获取引导安装
bun run setup

# 或手动安装：
# macOS/Linux
curl -fsSL https://opencode.ai/install.sh | bash

# Windows
irm https://opencode.ai/install.ps1 | iex
```

### 端口被占用

```bash
# 终止占用 5174 端口的进程
lsof -ti:5174 | xargs kill -9

# 或在 vite.config.ts 中修改端口
```

### 公网隧道不工作

1. 确保已安装 `cloudflared`：`bun run setup`
2. 检查网络连接
3. 尝试在远程访问页面重启隧道

---

## 贡献

欢迎贡献！请在提交 PR 前阅读贡献指南。

### 代码风格
- TypeScript 严格模式
- SolidJS 响应式模式
- 使用 Tailwind 进行样式设计

### 提交规范
- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档
- `refactor:` 代码重构

---

## 许可证

[MIT](LICENSE)

---

## 链接

- [OpenCode](https://opencode.ai) — AI 编程助手
- [文档](https://opencode.ai/docs) — OpenCode 文档
- [问题反馈](https://github.com/realDuang/opencode-remote/issues) — 报告 Bug 或请求功能

---

<div align="center">

**使用 [OpenCode](https://opencode.ai) 和 [SolidJS](https://solidjs.com) 构建**

</div>
