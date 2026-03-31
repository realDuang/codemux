# Claude Code v2.1.88 源码阅读指南

## 项目概览

这是从 npm 包 `@anthropic-ai/claude-code` 的 sourcemap 还原出的 TypeScript 源码，版本 2.1.88。
共计 **1902 个源文件**（1332 `.ts` + 552 `.tsx` + 18 `.js`），是一个基于 **React + Ink** 构建的终端 AI 助手。

---

## 一、整体架构（洋葱模型）

```
┌─────────────────────────────────────────────────────┐
│                  CLI 入口 (main.tsx)                  │
│    Commander.js 解析参数 → 初始化 → 启动 REPL/Print   │
├─────────────────────────────────────────────────────┤
│              UI 层 (Ink + React)                      │
│  screens/REPL.tsx  components/  hooks/  ink/          │
├─────────────────────────────────────────────────────┤
│           会话引擎 (query.ts + QueryEngine.ts)         │
│  消息循环 → API 调用 → 工具执行 → 结果注入 → 压缩       │
├─────────────────────────────────────────────────────┤
│          工具 & 命令层                                 │
│  tools/ (30+ 内置工具)    commands/ (80+ 斜杠命令)     │
├─────────────────────────────────────────────────────┤
│          服务层 (services/)                            │
│  API 通信  MCP 集成  分析  LSP  压缩  策略限制          │
├─────────────────────────────────────────────────────┤
│          基础设施层                                    │
│  utils/ (200+ 模块)  state/  types/  context/         │
│  权限  认证  Git  模型  配置  文件系统                   │
└─────────────────────────────────────────────────────┘
```

---

## 二、推荐阅读路线

### 路线 A：自顶向下（推荐新手）

#### 第 1 阶段：理解启动流程
1. **`main.tsx`** — CLI 入口（~800 行可见，实际极长）
   - 看 Commander.js 的参数定义
   - 看初始化顺序：性能 profiling → MDM 设置 → Keychain 预取 → 配置加载
   - 看最终如何调用 `launchRepl()` 或进入 print 模式
2. **`entrypoints/init.ts`** — 会话初始化
3. **`replLauncher.tsx`** — REPL 启动器
4. **`interactiveHelpers.tsx`** — 交互式辅助函数

#### 第 2 阶段：理解核心循环
5. **`query.ts`** — 主查询循环（核心！消息发送→工具调用→结果收集）
6. **`QueryEngine.ts`** — 状态机引擎（SDK/headless 模式的查询入口）
7. **`services/api/`** — API 通信层（看 claude.ts、errors.ts、withRetry.ts）

#### 第 3 阶段：理解工具系统
8. **`Tool.ts`** — Tool 接口定义 & ToolUseContext（极重要）
9. **`tools.ts`** — 工具注册表（看 `getTools()` 和 `assembleToolPool()`）
10. **选读工具实现**：
    - `BashTool/` — 最常用，理解权限和沙箱
    - `FileEditTool/` — 文件编辑的 diff 实现
    - `AgentTool/` — 子 Agent 的 fork/resurrection 机制
    - `GrepTool/` / `GlobTool/` — 搜索工具

#### 第 4 阶段：理解命令系统
11. **`commands.ts`** — 命令注册表
12. **`types/command.ts`** — Command 类型定义（prompt/local/local-jsx/fork）
13. **选读命令**：`commit.ts`、`review.ts`、`compact/`、`memory/`

#### 第 5 阶段：理解 UI
14. **`screens/REPL.tsx`** — 主 UI（~5000 行，核心中的核心）
15. **`components/`** — UI 组件库（消息渲染、权限对话框、工具进度）
16. **`ink/`** — Ink 终端渲染器扩展

---

### 路线 B：关注特定子系统

| 想了解的子系统 | 入口文件 | 关键文件 |
|---|---|---|
| **权限系统** | `utils/permissions/` | `PermissionMode.ts`, `permissionSetup.ts`, `classifierShared.ts`, `dangerousPatterns.ts` |
| **MCP 协议** | `services/mcp/` | `client.ts`, `config.ts`, `types.ts`, `InProcessTransport.ts` |
| **多 Agent** | `coordinator/` | `coordinatorMode.ts`, `tools/AgentTool/`, `tools/TeamCreateTool/` |
| **插件系统** | `plugins/`, `utils/plugins/` | `pluginLoader.ts`, `installedPluginsManager.ts`, `pluginDirectories.ts` |
| **技能系统** | `skills/`, `utils/skills/` | `bundled/index.ts`, `skillChangeDetector.ts` |
| **语音交互** | `voice/`, `hooks/useVoice*` | `voiceModeEnabled.ts`, `services/voiceStreamSTT.ts` |
| **Vim 模式** | `vim/` | `types.ts`(状态机), `motions.ts`, `operators.ts`, `transitions.ts` |
| **远程会话** | `remote/` | `RemoteSessionManager.ts`, `SessionsWebSocket.ts` |
| **状态管理** | `state/` | `store.ts`, `AppStateStore.ts`, `AppState.tsx` |
| **上下文窗口管理** | `services/compact/` | `autoCompact.ts`, `compact.ts`, `snipCompact.ts` |
| **费用追踪** | `cost-tracker.ts` | `costHook.ts`, `utils/modelCost.ts` |
| **分析/遥测** | `services/analytics/` | `growthbook.ts`, `index.ts`, `sink.ts` |
| **配置/设置** | `utils/settings/` | `settings.ts`, `settingsCache.ts`, `mdm/` |
| **Git 集成** | `utils/git*.ts` | `git.ts`, `gitDiff.ts`, `gitSettings.ts` |
| **认证** | `utils/auth*.ts` | `auth.ts`, `services/oauth/` |
| **LSP 集成** | `services/lsp/` | `manager.ts` |
| **Buddy 宠物** | `buddy/` | `types.ts`, `sprites.ts`, `companion.ts` |

---

## 三、核心数据流

### 1. 用户输入到 AI 响应的完整流程

```
用户输入文本
    ↓
REPL.tsx 捕获输入
    ↓
判断：斜杠命令？→ commands 系统处理
    ↓ (否，普通 prompt)
创建 UserMessage → 加入 messages 数组
    ↓
query.ts 启动查询循环:
  ├─ 1. normalizeMessagesForAPI() — 清理/格式化消息
  ├─ 2. 构建 SystemPrompt:
  │     ├─ getSystemContext() — Git 状态、分支、近期 commits
  │     ├─ getUserContext() — CLAUDE.md 记忆文件
  │     └─ 工具定义、权限信息
  ├─ 3. 调用 Claude API (流式):
  │     ├─ 支持 thinking blocks (extended thinking)
  │     └─ 支持 tool_use blocks (工具调用)
  ├─ 4. 解析工具调用 → 权限检查 → 执行工具
  │     ├─ canUseTool() — 权限网关
  │     ├─ tool.call() — 实际执行
  │     └─ 结果注入回消息流
  ├─ 5. 检查是否需要继续循环:
  │     ├─ 还有 tool_use？→ 继续
  │     ├─ 达到预算限制？→ 停止
  │     └─ 上下文窗口溢出？→ auto compact → 继续
  └─ 6. 返回最终 AssistantMessage
    ↓
REPL.tsx 渲染响应
```

### 2. 工具执行流程

```
API 返回 tool_use block
    ↓
findToolByName() — 从工具池查找
    ↓
canUseTool() — 权限检查:
  ├─ alwaysDeny 规则？→ 拒绝
  ├─ alwaysAllow 规则？→ 允许
  ├─ bypass 模式？→ 允许
  ├─ auto 模式？→ yoloClassifier 判断
  └─ default 模式？→ 弹出 UI 询问用户
    ↓
tool.call(args, context, canUseTool, onProgress)
    ↓
返回 ToolResult:
  { data, newMessages?, contextModifier?, mcpMeta? }
    ↓
结果序列化为 tool_result block → 加入消息流
```

### 3. MCP 工具集成流程

```
启动时:
  parseMcpConfig() — 解析 .anthropic/config.yaml
    ↓
  MCPServerConnection 建立连接 (stdio/websocket)
    ↓
  tools/list → 获取 MCP 工具定义
    ↓
  包装为内置 Tool 接口 → 合并到 assembleToolPool()

运行时:
  MCP 工具调用 → tool/call → 转发给 MCP 服务器
    ↓
  MCP 返回结果 → 包装为 ToolResult
```

---

## 四、关键设计模式

### 1. 特性门控（Feature Gating）— 三层体系
```typescript
// 编译时消除（Bun bundler DCE）
import { feature } from 'bun:bundle';
const VoiceMode = feature('VOICE_MODE') ? require('./voice.js') : null;

// 运行时（GrowthBook，可能有延迟）
getFeatureValue_CACHED_MAY_BE_STALE('feature_name');

// 环境变量
isEnvTruthy(process.env.CLAUDE_CODE_FLAG);
```

### 2. 延迟加载 & 循环依赖打破
```typescript
// 使用 lazy require getter 打破循环依赖
const getTeammateUtils = () =>
  require('./utils/teammate.js') as typeof import('./utils/teammate.js');
```

### 3. 自定义 Store（替代 Redux）
```typescript
// state/store.ts — 极简状态管理
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: () => void) => () => void
}
// 配合 useSyncExternalStore 使用，实现细粒度 selector 订阅
```

### 4. 权限模型（三层优先级）
```
Deny 规则 > Allow 规则 > 模式默认行为
  ├─ bypass 模式：全部允许（危险）
  ├─ auto 模式：ML 分类器自动判断
  └─ default 模式：询问用户
```

### 5. 磁盘流式输出（任务系统）
```
任务输出 → 写入磁盘文件（非内存）
  → 读取时按偏移量增量读取
  → 避免长时间运行任务导致 OOM
```

### 6. Prompt Cache 稳定性
```
工具池按名称排序 → 跨 turn 保持相同顺序
  → 确保系统提示的 prompt cache 命中率
```

---

## 五、关键文件速查表

### 必读文件（Top 15）

| 优先级 | 文件 | 行数估计 | 说明 |
|---|---|---|---|
| ⭐⭐⭐ | `main.tsx` | ~2000+ | CLI 入口，启动全流程 |
| ⭐⭐⭐ | `query.ts` | ~2000+ | 核心查询循环 |
| ⭐⭐⭐ | `Tool.ts` | ~300 | Tool 接口 & ToolUseContext |
| ⭐⭐⭐ | `tools.ts` | ~200 | 工具注册表 |
| ⭐⭐⭐ | `commands.ts` | ~200 | 命令注册表 |
| ⭐⭐ | `QueryEngine.ts` | ~2000+ | SDK 模式查询引擎 |
| ⭐⭐ | `context.ts` | ~200 | 系统/用户上下文构建 |
| ⭐⭐ | `state/AppStateStore.ts` | ~300 | 应用状态定义 |
| ⭐⭐ | `state/store.ts` | ~100 | 自定义 Store 实现 |
| ⭐⭐ | `types/message.ts` | ~300 | 消息类型定义 |
| ⭐⭐ | `types/permissions.ts` | ~200 | 权限类型定义 |
| ⭐ | `services/api/claude.ts` | ~500 | Claude API 客户端 |
| ⭐ | `services/mcp/client.ts` | ~500 | MCP 服务器管理 |
| ⭐ | `cost-tracker.ts` | ~150 | 费用追踪 |
| ⭐ | `Task.ts` | ~200 | 任务模型 |

### 有趣的发现

| 子系统 | 发现 |
|---|---|
| **Buddy 宠物系统** | 基于用户 ID hash 生成确定性宠物（18 种物种、稀有度分布、ASCII art）|
| **Speculation 预测** | 用户打字时预测性地开始推理，减少感知延迟 |
| **yoloClassifier** | Auto 模式下的 ML 分类器，自动判断工具调用是否安全 |
| **Coordinator 模式** | Leader-Worker 多 Agent 架构，Worker 有工具白名单限制 |
| **Vim 模式** | 完整的 Vi 有限状态机（支持 motions/operators/text objects/dot repeat）|
| **KAIROS** | 内部代号的 Assistant 模式（详见下方深入分析）|
| **内部标记** | `process.env.USER_TYPE === 'ant'` 区分内部/外部版本 |

---

## 附录：KAIROS (Assistant Mode) 深入分析

### 一、KAIROS 是什么？

**KAIROS** 是 Claude Code 的内部代号，代表 **"Assistant Mode"（助手模式）**。
它将 Claude Code 从一个本地命令行工具转变为一个 **远程守护进程(daemon)驱动的 AI Agent 服务**。

核心特性：
- 作为 **无头守护进程** 运行，通过 WebSocket 连接 CCR（Claude Code Remote）
- 通过远程 API 接收消息，而非本地 stdin
- 支持 **进程内多 Agent 团队** 生成
- 支持 **自主后台长期任务**
- 通过 **Channel 系统** 接入外部消息源（Slack、Discord、SMS 等）
- **推送通知** 将结果推送到用户设备

### 二、特性门控体系（7 个相关 Feature Flag）

```
feature('KAIROS')                    ← 主门控，控制整个 Assistant 子系统
feature('KAIROS_BRIEF')              ← Brief/SendUserMessage 工具独立门控
feature('KAIROS_PUSH_NOTIFICATION')  ← 推送通知独立门控
feature('KAIROS_GITHUB_WEBHOOKS')    ← GitHub PR Webhook 订阅
feature('KAIROS_CHANNELS')           ← MCP Channel 服务器支持
feature('KAIROS_DREAM')              ← /dream 技能（每夜记忆蒸馏）
feature('PROACTIVE')                 ← 自主执行模式（常与 KAIROS 配对）
```

常见搭配模式：
```typescript
feature('PROACTIVE') || feature('KAIROS')     // SleepTool, 自主循环
feature('KAIROS') || feature('KAIROS_BRIEF')  // Brief 相关功能
feature('KAIROS') || feature('KAIROS_CHANNELS') // Channel 通知
```

运行时门控：`tengu_kairos` (GrowthBook)，支持动态开关

### 三、激活流程

```
用户运行 `claude assistant [sessionId]`
    ↓
argv 预处理（main.tsx:685）
  → _pendingAssistantChat.sessionId = 指定ID
  → _pendingAssistantChat.discover = true（无参数时）
    ↓
main() action handler（main.tsx:1048-1089）
  ├─ 检查 --assistant 标志 → markAssistantForced()
  ├─ 检查 isAssistantMode()（读 .claude/settings.json）
  ├─ 信任验证：checkHasTrustDialogAccepted()
  │   （.claude/settings.json 在不可信仓库中可被攻击者控制）
  ├─ 门控检查：kairosGate.isKairosEnabled()
  │   （GrowthBook gate `tengu_kairos`，有磁盘缓存）
  └─ 激活副作用：
      ├─ setKairosActive(true)    ← 设置全局状态
      ├─ opts.brief = true        ← 强制启用 Brief 模式
      └─ initializeAssistantTeam() ← 预种子进程内 Agent 团队
    ↓
会话发现/连接分支（main.tsx:3259-3354）
  ├─ discoverAssistantSessions() → API 发现可用会话
  ├─ 0 个会话 → launchAssistantInstallWizard() → 安装守护进程
  ├─ 1 个会话 → 直接连接
  ├─ 多个会话 → launchAssistantSessionChooser() → 用户选择
  └─ 连接目标会话：
      ├─ createRemoteSessionConfig(viewerOnly: true)
      ├─ setIsRemoteMode(true)
      └─ launchRepl() → REPL 作为远程纯查看器
```

### 四、KAIROS 专属工具

| 工具 | Feature Gate | 用途 |
|---|---|---|
| **SleepTool** | `PROACTIVE \| KAIROS` | 等待指定时间，比 `bash sleep` 不占 shell 进程。收到 `<tick>` 提示时检查有无工作，否则继续睡眠 |
| **SendUserMessage** (BriefTool) | `KAIROS \| KAIROS_BRIEF` | Agent 的主要输出通道。在 Brief 模式下，工具外的文本用户看不到，必须通过此工具发消息 |
| **SendUserFileTool** | `KAIROS` | 向连接的用户发送文件（限于 agent 创建/修改的文件）|
| **PushNotificationTool** | `KAIROS \| KAIROS_PUSH_NOTIFICATION` | 向用户设备发送推送通知（如长任务完成时）|
| **SubscribePRTool** | `KAIROS_GITHUB_WEBHOOKS` | 订阅 GitHub PR webhooks，通过 channel 通知接收实时 PR 更新 |

### 五、Channel 系统 — 外部消息源集成

Channel 是 KAIROS 的核心创新之一，让 Claude 能接入外部消息平台：

```
外部消息源 (Slack/Discord/SMS/Telegram)
    ↓
MCP Channel Server（声明 experimental['claude/channel']）
    ↓
notifications/claude/channel 通知
    ↓
wrapChannelMessage() → <channel source="slack" user="bob">消息内容</channel>
    ↓
入队到消息队列 → SleepTool 1s 内唤醒
    ↓
模型看到来源，决定用哪个工具回复
```

Channel 权限流程（远程权限审批）：
```
Agent 需要工具权限 → CC 发送 channel/permission_request
    ↓
Channel Server 将请求格式化（Telegram markdown, Discord embed 等）
    ↓
用户在手机上回复 "yes tbxkq"
    ↓
Server 解析并发送 channel/permission 通知
    ↓
CC 匹配 request_id → 批准工具使用
```

安全机制：
- 需要 claude.ai OAuth 认证（API key 用户被拦截）
- Team/Enterprise 组织需管理员显式启用 `channelsEnabled: true`
- 允许列表由 GrowthBook 管控或组织管理员自定义
- Meta key 验证防止 XML 属性注入

### 六、记忆系统 — 每日日志模式

KAIROS 改变了记忆系统的工作方式：

**普通模式**: Agent 维护 `MEMORY.md` 作为活跃索引
**KAIROS 模式**: Agent 使用 **仅追加的每日日志** (`logs/YYYY/MM/YYYY-MM-DD.md`)

```
工作中产生的记忆
    ↓
追加到 logs/2026/03/2026-03-31.md（时间戳 bullet）
    ↓
每夜 /dream 技能自动运行
    ↓
蒸馏日志 → 更新 MEMORY.md + 主题文件
```

日志路径: `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`
蒸馏技能: `skills/bundled/dream.ts`（`KAIROS | KAIROS_DREAM` 门控）

### 七、远程会话管理

```typescript
// 核心类型
type RemoteSessionConfig = {
  sessionId: string;
  getAccessToken: () => string;  // 闭包，重连时刷新 token
  orgUuid: string;
  hasInitialPrompt?: boolean;
  viewerOnly?: boolean;  // claude assistant 模式为 true
}

// 消息流
LocalCLI → HTTP POST /v1/sessions/{id}/messages → 远程 Agent 处理
                                                      ↓
WebSocket 事件流 ← RemoteSessionManager.onMessage()
                                                      ↓
                                                  本地 UI 渲染
```

会话历史 API: `GET /v1/sessions/{id}/events`
- Beta header: `anthropic-beta: ccr-byoc-2025-07-29`
- 游标分页: `anchor_to_latest=true` + `before_id` 向前翻页
- 惰性加载: 连接时不阻塞，用户滚动时按需加载

### 八、被死代码消除的文件

以下文件在 `feature('KAIROS')` 为 false 的外部构建中被移除，
因此在还原的源码中 **不存在实际内容**（只能从调用点推断接口）：

| 文件 | 推断的导出 |
|---|---|
| `assistant/index.ts` | `isAssistantMode()`, `markAssistantForced()`, `isAssistantForced()`, `initializeAssistantTeam()`, `getAssistantSystemPromptAddendum()`, `getAssistantActivationPath()` |
| `assistant/gate.ts` | `isKairosEnabled()` — GrowthBook gate `tengu_kairos` |
| `assistant/sessionDiscovery.ts` | `discoverAssistantSessions()` → `AssistantSession[]` |
| `assistant/AssistantSessionChooser.tsx` | React 组件，会话选择器 UI |
| `commands/assistant/assistant.ts` | `NewInstallWizard`, `computeDefaultInstallDir()` |
| `commands/assistant/index.ts` | `/assistant` 斜杠命令定义 |
| `tools/SleepTool/SleepTool.ts` | SleepTool 实现 |
| `tools/SendUserFileTool/SendUserFileTool.ts` | 文件发送工具实现 |
| `tools/PushNotificationTool/PushNotificationTool.ts` | 推送通知工具实现 |
| `tools/SubscribePRTool/SubscribePRTool.ts` | GitHub Webhook 订阅工具 |

### 九、KAIROS 架构全景图

```
┌─────────────────────────────────────────────────────────────┐
│                      用户端 (Client)                         │
│  `claude assistant` → REPL (viewerOnly=true, Brief 模式)     │
│  ├─ 惰性历史加载 (cursor pagination)                          │
│  ├─ WebSocket 实时事件流                                      │
│  └─ Channel 权限审批 (手机/桌面推送)                            │
├─────────────────────────────────────────────────────────────┤
│                    CCR 远程层 (Transport)                     │
│  HTTP POST /v1/sessions/{id}/messages (发消息)                │
│  WebSocket /v1/sessions/{id}/events  (接收事件流)              │
│  OAuth + Beta header: ccr-byoc-2025-07-29                    │
├─────────────────────────────────────────────────────────────┤
│                  Agent 守护进程 (Daemon)                       │
│  ├─ 无头运行，进程内多 Agent 团队                               │
│  ├─ Proactive 自主循环 (<tick> → 检查工作 → Sleep)             │
│  ├─ Channel 系统 (Slack/Discord/SMS MCP Server)              │
│  ├─ 每日日志记忆 (append-only → 夜间 /dream 蒸馏)             │
│  └─ 专属工具:                                                │
│      SendUserMessage  PushNotification  SendUserFile         │
│      SleepTool  SubscribePR  ScheduleCron                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 六、目录规模统计

| 目录 | 文件数 | 说明 |
|---|---|---|
| `utils/` | 564 | 基础工具库（最大） |
| `components/` | 389 | UI 组件 |
| `commands/` | 207 | 斜杠命令 |
| `tools/` | 184 | 内置工具 |
| `services/` | 130 | 服务层 |
| `hooks/` | 104 | React Hooks |
| `ink/` | 96 | 终端渲染 |
| `bridge/` | 31 | IDE 桥接 |
| `constants/` | 21 | 常量定义 |
| `skills/` | 20 | 技能系统 |
| 其他 | ~158 | 各子系统 |

---

## 附录 B：核心消息循环 (query.ts) 深度分析

### 一、概览

`query.ts` 是 Claude Code 最核心的文件（~1730 行），实现了 **消息→API→工具→结果→循环** 的完整 agentic loop。它是一个 **AsyncGenerator**，通过 `yield` 逐步向调用者（REPL/SDK）发送流式事件。

```typescript
// 函数签名
export async function* query(params: QueryParams): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal  // 返回值：循环终止原因
>
```

### 二、循环状态机

query 内部是一个 `while(true)` 循环，每次迭代称为一个 **turn**。循环的可变状态被封装在 `State` 对象中：

```typescript
type State = {
  messages: Message[]                  // 当前消息历史
  toolUseContext: ToolUseContext        // 工具执行上下文
  autoCompactTracking: ...             // 自动压缩状态
  maxOutputTokensRecoveryCount: number // 输出截断恢复计数（最多3次）
  hasAttemptedReactiveCompact: boolean // 是否已尝试响应式压缩
  maxOutputTokensOverride: number      // 输出 token 上限覆盖
  pendingToolUseSummary: Promise<...>  // 上一轮的摘要（异步Haiku生成）
  stopHookActive: boolean              // stop hook 是否激活
  turnCount: number                    // 当前 turn 编号
  transition: Continue | undefined     // 上次 continue 的原因
}
```

### 三、单次迭代的完整流程

```
┌─────────────────────────────────────────────────────────────┐
│                    while(true) 循环体                        │
│                                                              │
│  ① 预处理阶段（消息准备）                                      │
│  ├─ getMessagesAfterCompactBoundary() → 取压缩边界后的消息       │
│  ├─ applyToolResultBudget()           → 工具结果大小预算控制     │
│  ├─ snipCompactIfNeeded()             → 裁剪旧消息 (HISTORY_SNIP)│
│  ├─ microcompact()                    → 微压缩（缓存编辑）       │
│  ├─ applyCollapsesIfNeeded()          → 上下文折叠 (CONTEXT_COLLAPSE)│
│  └─ autocompact()                     → 自动压缩（context 溢出时）│
│                                                              │
│  ② 上下文窗口溢出检测                                          │
│  ├─ calculateTokenWarningState()                              │
│  └─ 硬阻塞限制 → return { reason: 'blocking_limit' }          │
│                                                              │
│  ③ API 流式调用                                               │
│  ├─ deps.callModel({                                         │
│  │     messages: prependUserContext(msgs, userContext),       │
│  │     systemPrompt: appendSystemContext(sysPrompt, sysCtx), │
│  │     thinkingConfig, tools, signal, model, ...             │
│  │   })                                                      │
│  ├─ for await (const message of stream):                     │
│  │   ├─ 收集 AssistantMessage                                │
│  │   ├─ 提取 tool_use blocks → needsFollowUp = true          │
│  │   ├─ 流式工具执行器: streamingToolExecutor.addTool()        │
│  │   ├─ 扣留可恢复错误（prompt-too-long, max_output_tokens）  │
│  │   └─ yield 非扣留消息给调用者                               │
│  └─ 模型回退: FallbackTriggeredError → 切换模型重试             │
│                                                              │
│  ④ 后采样处理                                                 │
│  ├─ executePostSamplingHooks()                                │
│  └─ 中断检测: abortController.signal.aborted?                 │
│      → return { reason: 'aborted_streaming' }                │
│                                                              │
│  ⑤ 分支判断: needsFollowUp?                                  │
│                                                              │
│  ┌─── needsFollowUp = false (无工具调用，模型回复完成) ────┐    │
│  │  A. 错误恢复:                                           │
│  │     ├─ prompt-too-long → 尝试 collapse drain / reactive │
│  │     │    compact → state = ...; continue                 │
│  │     ├─ max_output_tokens → 升级 8k→64k; 或注入恢复消息  │
│  │     │    "Resume directly, no recap" → continue          │
│  │     └─ media_size_error → reactive compact strip-retry   │
│  │  B. Stop Hooks:                                         │
│  │     ├─ handleStopHooks() → 可能注入 blocking errors      │
│  │     └─ blockingErrors → state = ...; continue           │
│  │  C. Token Budget 检查 (TOKEN_BUDGET feature):           │
│  │     └─ 未用完 → 注入 nudge 消息 → continue              │
│  │  D. 正常完成:                                           │
│  │     └─ return { reason: 'completed' }                   │
│  └──────────────────────────────────────────────────────────┘
│                                                              │
│  ┌─── needsFollowUp = true (有工具调用，需要执行) ─────────┐   │
│  │  ⑥ 工具执行阶段                                        │
│  │  ├─ 流式执行: streamingToolExecutor.getRemainingResults() │
│  │  │  或传统执行: runTools(toolUseBlocks, ...)             │
│  │  ├─ 收集 toolResults[]                                  │
│  │  ├─ 中断检测 → return { reason: 'aborted_tools' }      │
│  │  └─ hook 阻止 → return { reason: 'hook_stopped' }      │
│  │                                                         │
│  │  ⑦ 附件注入阶段                                         │
│  │  ├─ getAttachmentMessages() → CLAUDE.md, 文件变更通知    │
│  │  ├─ filterDuplicateMemoryAttachments() → 记忆文件去重    │
│  │  ├─ collectSkillDiscoveryPrefetch() → 技能发现结果       │
│  │  └─ 排队命令消费（task-notification, prompt）            │
│  │                                                         │
│  │  ⑧ 工具摘要生成（异步 Haiku 调用，不阻塞下一轮）          │
│  │  └─ generateToolUseSummary() → 下一轮开始时 await        │
│  │                                                         │
│  │  ⑨ Max turns 检查                                       │
│  │  └─ turnCount > maxTurns → return { reason: 'max_turns' }│
│  │                                                         │
│  │  ⑩ 构建下一轮状态                                       │
│  │  state = {                                              │
│  │    messages: [...msgs, ...assistantMsgs, ...toolResults],│
│  │    turnCount: turnCount + 1,                            │
│  │    transition: { reason: 'next_turn' }                  │
│  │  }                                                      │
│  │  continue → 回到 while(true) 顶部                       │
│  └──────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
```

### 四、循环的 11 种 continue 原因（transition.reason）

| reason | 触发条件 | 描述 |
|---|---|---|
| `next_turn` | 工具执行完毕 | 正常循环：工具结果注入后继续 |
| `collapse_drain_retry` | prompt-too-long + 有 staged collapse | 排空上下文折叠后重试 |
| `reactive_compact_retry` | prompt-too-long + reactive compact 成功 | 响应式压缩后重试 |
| `max_output_tokens_escalate` | 输出截断 + 未覆盖上限 | 升级 max_output 8k→64k 重试 |
| `max_output_tokens_recovery` | 输出截断 + 恢复次数<3 | 注入"继续，别道歉"消息后重试 |
| `stop_hook_blocking` | stop hook 返回 blocking errors | 注入 hook 错误消息后重试 |
| `token_budget_continuation` | token 预算未用完 | 注入 nudge 消息继续生成 |

### 五、循环的 12 种终止原因（Terminal.reason）

| reason | 描述 |
|---|---|
| `completed` | 正常完成（模型无工具调用） |
| `blocking_limit` | 上下文窗口硬阻塞限制 |
| `prompt_too_long` | prompt 过长且所有恢复均失败 |
| `image_error` | 图片大小/格式错误 |
| `model_error` | API 调用抛出异常 |
| `aborted_streaming` | 用户在 API 流式传输中中断 |
| `aborted_tools` | 用户在工具执行中中断 |
| `hook_stopped` | 工具 hook 阻止继续 |
| `stop_hook_prevented` | stop hook 阻止继续 |
| `max_turns` | 达到最大 turn 数限制 |

### 六、工具执行子系统

#### 6.1 两种执行模式

```
StreamingToolExecutor（默认）          runTools（传统）
  │                                      │
  ├─ API 流式传输 *同时* 执行工具         ├─ API 完成后执行工具
  ├─ addTool() 在流中立即启动             ├─ 按批次串行/并行
  ├─ getCompletedResults() 中间收割       ├─ partitionToolCalls() 分批
  └─ getRemainingResults() 最终收割       └─ 更简单但更慢
```

#### 6.2 并发控制（partitionToolCalls）

```typescript
// 工具被分成批次:
// - concurrency-safe 的工具 → 同一批次并行执行（最多10个）
// - 非 concurrency-safe 的工具 → 单独批次串行执行

Batch 1: [GrepTool, GlobTool, FileReadTool]  → 并行
Batch 2: [BashTool]                           → 串行（独占）
Batch 3: [FileReadTool, FileReadTool]         → 并行
Batch 4: [FileEditTool]                       → 串行（独占）
```

判断标准：`tool.isConcurrencySafe(input)` — 每个工具自己决定

#### 6.3 单个工具执行流程

```
runToolUse(toolUseBlock, assistantMessage, canUseTool, context)
    ↓
1. 查找工具: findToolByName() → 找不到则返回错误
    ↓
2. 中断检测: abortController.signal.aborted?
    ↓
3. streamedCheckPermissionsAndCallTool():
    ↓
   3a. 输入验证: tool.inputSchema.safeParse(input)
       → Zod 验证失败 → 返回格式化错误
       → 附带 schema-not-sent 提示（ToolSearch 场景）
    ↓
   3b. 自定义验证: tool.validateInput(parsedInput, context)
    ↓
   3c. Pre-tool-use hooks: runPreToolUseHooks()
       → hook 可以修改/拒绝工具调用
    ↓
   3d. 权限检查: canUseTool(tool, parsedInput, context)
       ├─ alwaysDeny 规则? → 拒绝
       ├─ alwaysAllow 规则? → 允许
       ├─ bypass 模式? → 允许
       ├─ auto 模式? → yoloClassifier 判断
       └─ default 模式? → 弹出 UI 询问用户
    ↓
   3e. 实际执行: tool.call(parsedInput, context, canUseTool, onProgress)
       → 返回 { data, newMessages?, contextModifier? }
    ↓
   3f. 结果处理:
       ├─ tool.mapToolResultToToolResultBlockParam() → API 格式
       ├─ processToolResultBlock() → 大小限制、截断
       └─ Post-tool-use hooks: runPostToolUseHooks()
    ↓
   3g. yield { message: createUserMessage(tool_result), contextModifier }
```

### 七、消息预处理管线

每次迭代开始时，消息经过 5 层处理管线：

```
原始 messages[]
    ↓ ① getMessagesAfterCompactBoundary()
    │    跳过压缩边界前的旧消息
    ↓ ② applyToolResultBudget()
    │    对聚合工具结果施加大小预算
    │    过大的结果被替换为 "[content replaced — N bytes]"
    ↓ ③ snipCompactIfNeeded() [HISTORY_SNIP]
    │    裁剪早期 turn 的 thinking/tool_result 内容
    │    释放 token 但保留消息结构
    ↓ ④ microcompact()
    │    微压缩：删除旧的 tool_use/tool_result 对的详细内容
    │    保留摘要（"Tool X was called with Y"）
    ↓ ⑤ autocompact() / applyCollapsesIfNeeded()
         如果估算 token 数接近上下文窗口:
         ├─ autocompact: 用 Claude 生成完整摘要替换历史
         └─ contextCollapse: 折叠特定消息段（更细粒度）
    ↓
处理后的 messagesForQuery[] → 发送给 API
```

### 八、恢复机制（错误自愈）

#### 8.1 Prompt-too-long 恢复（3级瀑布）

```
API 返回 prompt_too_long 错误
    ↓ (扣留，不立即 yield 给用户)
Level 1: Context Collapse drain
    → 排空所有 staged 折叠
    → 成功? continue (collapse_drain_retry)
    ↓ 失败
Level 2: Reactive Compact
    → 紧急触发完整压缩
    → 成功? continue (reactive_compact_retry)
    ↓ 失败
Level 3: 放弃
    → yield 错误消息给用户
    → return { reason: 'prompt_too_long' }
```

#### 8.2 Max-output-tokens 恢复（3级瀑布）

```
API 返回 max_output_tokens 停止
    ↓ (扣留)
Level 1: 升级 token 上限 (8k → 64k)
    → continue (max_output_tokens_escalate)
    ↓ 仍然截断
Level 2: 注入恢复消息 "Resume directly — no recap"
    → 最多重试 3 次
    → continue (max_output_tokens_recovery)
    ↓ 3 次仍截断
Level 3: 放弃，yield 扣留的错误
```

#### 8.3 模型回退

```
API 返回 FallbackTriggeredError（高负载）
    ↓
丢弃已收集的 assistantMessages（发 tombstone）
切换到 fallbackModel
重置 StreamingToolExecutor
yield 警告消息 "Switched to ${fallback} due to high demand"
continue（同一次 while 循环内的 inner retry）
```

### 九、附件系统（turn 间注入）

每次工具执行完毕后、下一轮 API 调用前，系统注入多种附件：

```
工具执行完成
    ↓
① getAttachmentMessages():
   ├─ CLAUDE.md 记忆文件更新
   ├─ 文件变更通知 (edited_text_file)
   ├─ 排队命令 (task-notification / prompt)
   └─ 日期变更通知 (KAIROS 午夜翻转)
    ↓
② filterDuplicateMemoryAttachments():
   └─ 去重已经通过 FileRead 读过的记忆文件
    ↓
③ collectSkillDiscoveryPrefetch():
   └─ 注入技能发现结果（异步 Haiku 调用的结果）
    ↓
所有附件 → append to toolResults[] → 下一轮消息的一部分
```

### 十、关键性能优化

| 优化 | 机制 |
|---|---|
| **流式工具执行** | API 还在流式传输时就开始执行已确认的工具 |
| **工具摘要异步生成** | 用 Haiku 异步生成摘要，不阻塞下一轮 API 调用 |
| **记忆预取** | `startRelevantMemoryPrefetch()` 在 turn 开始时发起 |
| **技能发现预取** | 在模型流式传输期间异步搜索相关技能 |
| **Prompt cache 稳定性** | 工具池排序稳定；消息不可变（clone-on-yield） |
| **Token 估算替代精确计数** | `tokenCountWithEstimation()` 避免每轮精确计数 |
| **微压缩缓存** | 微压缩结果可缓存，跨 turn 复用 |

### 十一、REPL 如何调用 query

```typescript
// screens/REPL.tsx 中（简化）:
const generator = query({
  messages,
  systemPrompt,
  userContext, systemContext,
  canUseTool,
  toolUseContext,
  querySource: 'repl_main_thread',
});

for await (const event of generator) {
  switch (event.type) {
    case 'stream_request_start':
      // 显示 spinner
      break;
    case 'assistant':
      // 渲染 AI 回复（流式）
      break;
    case 'user':
      // 工具结果消息
      break;
    case 'progress':
      // 更新工具进度 UI
      break;
    case 'attachment':
      // 附件消息
      break;
    case 'tombstone':
      // 移除无效消息
      break;
    case 'tool_use_summary':
      // 工具使用摘要（移动端显示）
      break;
    // ...
  }
}
// generator 返回 Terminal → 处理终止原因
```

---

---

## 附录 C：工具系统 (Tool) 全面分析

### 一、Tool 接口定义（Tool.ts，~700 行）

每个工具必须实现以下核心接口：

```typescript
type Tool<Input, Output, Progress> = {
  // ─── 身份 ───
  name: string                     // 主名称
  aliases?: string[]               // 向后兼容别名（如 KillShell → TaskStop）
  searchHint?: string              // ToolSearch 关键词匹配提示（3-10 词）
  isMcp?: boolean                  // 是否来自 MCP 服务器
  shouldDefer?: boolean            // 是否延迟加载（需要 ToolSearch 发现后才可调用）
  alwaysLoad?: boolean             // 始终加载，不延迟

  // ─── Schema ───
  inputSchema: ZodType<Input>      // Zod 输入验证
  outputSchema?: ZodType<Output>   // Zod 输出验证
  inputJSONSchema?: ToolInputJSONSchema  // MCP 工具直接用 JSON Schema

  // ─── 行为属性 ───
  isConcurrencySafe(input): boolean   // 能否与其他工具并行执行
  isEnabled(): boolean                 // 当前环境是否启用
  isReadOnly(input): boolean           // 是否只读
  isDestructive?(input): boolean       // 是否不可逆操作
  interruptBehavior?(): 'cancel'|'block' // 用户中断时的行为
  maxResultSizeChars: number           // 结果超过此大小则持久化到磁盘

  // ─── 执行 ───
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>
  call(args, context, canUseTool, parentMsg, onProgress?): Promise<ToolResult<Output>>

  // ─── 提示 ───
  description(input, options): Promise<string>
  prompt(options): Promise<string>

  // ─── UI 渲染（React/Ink）───
  userFacingName(input): string
  renderToolUseMessage(input, options): ReactNode
  renderToolResultMessage?(output, progress, options): ReactNode
  renderToolUseProgressMessage?(progress, options): ReactNode
  renderToolUseRejectedMessage?(input, options): ReactNode
  renderToolUseErrorMessage?(result, options): ReactNode
  renderGroupedToolUse?(toolUses, options): ReactNode | null

  // ─── 分类器 & 搜索 ───
  toAutoClassifierInput(input): unknown  // 给 yoloClassifier 的简化表示
  isSearchOrReadCommand?(input): { isSearch, isRead, isList? }
  extractSearchText?(output): string     // 转录搜索索引
  getActivityDescription?(input): string | null  // spinner 描述
}
```

### 二、工具注册表（tools.ts）

#### 核心函数

| 函数 | 用途 |
|---|---|
| `getAllBaseTools()` | 返回完整内置工具列表（40+），是**唯一真相源** |
| `getTools(permCtx)` | 过滤 deny 规则 + `isEnabled()` + REPL 模式隐藏 |
| `assembleToolPool(permCtx, mcpTools)` | 合并内置 + MCP 工具，去重排序（核心！）|
| `filterToolsByDenyRules(tools, permCtx)` | 按 deny 规则过滤工具 |

#### assembleToolPool 排序策略

```
内置工具（按名称字母排序）→ MCP 工具（按名称字母排序）
  └─ 内置工具作为连续前缀，保证 prompt cache 稳定性
  └─ uniqBy('name') → 内置工具在名称冲突时优先
```

### 三、完整工具清单（40+ 内置工具）

#### 核心文件/代码操作

| 工具 | 并发安全 | 只读 | 延迟 | 说明 |
|---|---|---|---|---|
| **BashTool** | ✅ | 按命令 | ❌ | Shell 命令执行，AST 级安全分析，流式输出 |
| **PowerShellTool** | ✅ | 按命令 | ❌ | Windows PowerShell（条件启用）|
| **FileReadTool** | ✅ | ✅ | ❌ | 读取文件，支持行范围，maxResultSizeChars=∞ |
| **FileEditTool** | ✅ | ❌ | ❌ | 搜索替换编辑，引号/编码保留，智能模糊匹配 |
| **FileWriteTool** | ✅ | ❌ | ❌ | 创建新文件 |
| **NotebookEditTool** | ✅ | ❌ | ✅ | .ipynb cell 编辑（insert/replace/delete）|
| **GrepTool** | ✅ | ✅ | ❌ | ripgrep 包装，支持正则 |
| **GlobTool** | ✅ | ✅ | ❌ | 文件模式匹配 |

#### 搜索 & 网络

| 工具 | 并发安全 | 只读 | 延迟 | 说明 |
|---|---|---|---|---|
| **WebFetchTool** | ✅ | ✅ | ✅ | URL 抓取→Markdown，Haiku 摘要，预批准域名 |
| **WebSearchTool** | ✅ | ✅ | ✅ | 原生 SDK web_search，最多 8 次搜索，流式结果 |
| **WebBrowserTool** | - | - | - | 浏览器自动化（WEB_BROWSER_TOOL 门控）|
| **LSPTool** | - | ✅ | ✅ | Language Server Protocol：定义跳转、引用查找等 9 种操作 |
| **ToolSearchTool** | ✅ | ✅ | ❌ | 工具发现/延迟加载优化（永不延迟自身）|

#### 多 Agent & 任务

| 工具 | 并发安全 | 只读 | 延迟 | 说明 |
|---|---|---|---|---|
| **AgentTool** | - | ❌ | ❌* | 子 Agent 生成（fork/resurrection/async），支持 worktree 隔离 |
| **SkillTool** | ✅ | ❌ | ✅ | 技能调用（fork 到子 agent 执行）|
| **TaskCreateTool** | ✅ | ❌ | ✅ | 创建任务（TodoV2 系统）|
| **TaskGetTool** | ✅ | ✅ | ✅ | 查询任务状态 |
| **TaskListTool** | ✅ | ✅ | ✅ | 列出所有任务 |
| **TaskUpdateTool** | - | ❌ | ✅ | 更新任务状态/字段 |
| **TaskOutputTool** | ✅ | ✅ | ❌ | 获取任务输出（支持阻塞等待完成）|
| **TaskStopTool** | ✅ | ❌ | ✅ | 停止运行中的任务（别名 KillShell）|
| **TeamCreateTool** | - | ❌ | ✅ | 创建 Agent 团队（Swarm 模式）|
| **TeamDeleteTool** | - | ❌ | ✅ | 删除 Agent 团队 |
| **SendMessageTool** | - | ❌ | ✅ | 团队内消息传递（支持广播、UDS、Bridge）|

#### 交互 & 模式

| 工具 | 并发安全 | 只读 | 延迟 | 说明 |
|---|---|---|---|---|
| **AskUserQuestionTool** | ✅ | ✅ | ✅ | 多选/单选/自由文本 UI（最多 4 题×4 选项）|
| **EnterPlanModeTool** | ✅ | ✅ | ✅ | 进入 Plan 模式（权限切换）|
| **ExitPlanModeV2Tool** | ✅ | ✅ | ❌ | 退出 Plan 模式 |
| **EnterWorktreeTool** | - | ❌ | ✅ | 创建隔离 git worktree |
| **ExitWorktreeTool** | - | ❌ | ✅ | 退出 worktree |
| **TodoWriteTool** | - | ❌ | ✅ | 写入 todo 列表（旧系统）|
| **BriefTool** | ✅ | ✅ | ❌ | SendUserMessage（KAIROS/Brief 模式输出通道）|
| **ConfigTool** | - | 按操作 | ✅ | 读写配置（ANT-only）|

### 四、工具延迟加载系统（ToolSearch）

#### 核心思想
不在每次 API 调用中发送所有工具 schema（节省 prompt cache + token）。
不常用的工具标记为 `shouldDefer: true`，模型需要时先调用 `ToolSearch` 加载。

```
初始 prompt: 只包含 ~15 个核心工具的完整 schema
     + ToolSearch 工具（可搜索其余 25+ 工具）
     + 延迟工具只发送 name（无 schema，1P/Foundry 用 defer_loading:true）
         ↓
模型需要某延迟工具 → 调用 ToolSearch("select:WebFetch")
         ↓
ToolSearch 返回工具定义 → 模型可正常调用
```

#### 搜索评分
| 匹配类型 | 分数 |
|---|---|
| MCP 工具名精确匹配 | 12 分 |
| 内置工具名精确匹配 | 10 分 |
| searchHint 匹配 | 4 分 |
| description 匹配 | 2 分 |

#### 直接选择语法
`select:ToolA,ToolB,ToolC` — 精确加载指定工具，无需搜索

### 五、权限矩阵（constants/tools.ts）

```
ALL_AGENT_DISALLOWED_TOOLS（所有子 Agent 禁用）:
  TaskOutput, ExitPlanMode, EnterPlanMode, AskUserQuestion, TaskStop
  AgentTool（外部构建禁止嵌套，ANT 允许）

ASYNC_AGENT_ALLOWED_TOOLS（异步 Agent 允许）:
  FileRead, FileEdit, FileWrite, Grep, Glob, WebSearch, WebFetch
  NotebookEdit, SkillTool, ToolSearch, Shell 工具, TodoWrite
  EnterWorktree, ExitWorktree, SyntheticOutput

COORDINATOR_MODE_ALLOWED_TOOLS（协调者只能用）:
  Agent, TaskStop, SendMessage, SyntheticOutput

IN_PROCESS_TEAMMATE_ALLOWED_TOOLS（进程内队友额外允许）:
  TaskCreate, TaskGet, TaskList, TaskUpdate, SendMessage, Cron 工具
```

---

## 附录 D：命令系统 (Command) 全面分析

### 一、Command 类型体系

```typescript
// 判别联合类型
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

#### 三种命令类型

| 类型 | 特点 | 示例 |
|---|---|---|
| **PromptCommand** | 扩展为 prompt 发送给模型，支持 inline/fork 执行 | `/commit`, `/review`, `/init`, 所有 skills |
| **LocalCommand** | 本地同步执行，返回文本 | `/clear`, `/cost`, `/vim`, `/version` |
| **LocalJSXCommand** | 渲染 Ink React UI，异步完成 | `/config`, `/model`, `/resume`, `/mcp` |

#### PromptCommand 高级特性

```typescript
{
  context?: 'inline' | 'fork'   // inline=扩展到对话; fork=子Agent独立执行
  agent?: string                 // fork 时用的 agent 类型
  hooks?: HooksSettings          // 调用时注册的 hooks
  allowedTools?: string[]        // 限制可用工具
  paths?: string[]               // glob 模式，匹配文件后才可见
  source: 'builtin'|'mcp'|'plugin'|'bundled'|SettingSource
}
```

#### CommandBase 共享字段

```typescript
{
  name: string                    // /name
  aliases?: string[]              // 别名
  availability?: ('claude-ai'|'console')[]  // 认证要求
  isEnabled?: () => boolean       // 运行时门控
  isHidden?: boolean              // 隐藏（不出现在补全/帮助中）
  loadedFrom?: 'skills'|'plugin'|'managed'|'bundled'|'mcp'|...
  immediate?: boolean             // 立即执行（不排队）
  isSensitive?: boolean           // 参数脱敏
  whenToUse?: string              // 模型用的使用场景描述
  disableModelInvocation?: boolean // 禁止模型调用
}
```

### 二、命令注册与加载

```
getCommands() — 主入口（每次命令补全/调用时调用）
    ↓
loadAllCommands(cwd) — 合并所有来源（memoized by cwd）
  ├─ COMMANDS()           — 50+ 内置命令
  ├─ getBundledSkills()   — 15+ 捆绑技能
  ├─ getSkillDirCommands() — ~/.claude/skills/ + .claude/skills/
  ├─ getPluginCommands()  — 已安装插件命令
  ├─ getPluginSkills()    — 已安装插件技能
  ├─ getWorkflowCommands() — 工作流命令
  └─ getBuiltinPluginSkillCommands() — 内置插件技能
    ↓
过滤: meetsAvailabilityRequirement() + isCommandEnabled()
    ↓
合并动态技能（文件操作中发现的）
    ↓
最终命令列表
```

### 三、完整命令分类（100+ 命令）

#### 会话管理
`/resume` `/session` `/clear` `/rename` `/compact` `/exit` `/summary` `/teleport` `/branch` `/rewind`

#### Git & 代码审查
`/commit` `/commit-push-pr` `/review` `/ultrareview` `/security-review` `/diff` `/autofix-pr`

#### 配置 & 设置
`/config` `/model` `/effort` `/theme` `/color` `/output-style` `/keybindings` `/vim` `/env` `/fast` `/permissions` `/privacy-settings`

#### 工具 & 集成
`/mcp` `/ide` `/plugin` `/reload-plugins` `/hooks` `/skills` `/tasks` `/chrome`

#### 认证
`/login` `/logout` `/oauth-refresh`

#### 帮助 & 诊断
`/help` `/status` `/doctor` `/version` `/release-notes`

#### 费用 & 用量
`/cost` `/usage` `/extra-usage` `/stats` `/insights`

#### 项目设置
`/init` `/init-verifiers` `/onboarding` `/plan` `/add-dir` `/memory`

#### 特殊功能
`/btw` `/copy` `/feedback` `/export` `/voice` `/upgrade` `/desktop` `/mobile` `/stickers`

#### 实验性（Feature-Gated）
`/brief` `/buddy` `/bridge` `/ultraplan` `/fork` `/thinkback`

#### 内部专用（ANT-only）
`/good-claude` `/issue` `/backfill-sessions` `/ctx_viz` `/mock-limits` `/ant-trace` `/debug-tool-call` `/perf-issue` `/break-cache`

### 四、斜杠命令执行流程

```
用户输入 "/commit fix typo"
    ↓
parseSlashCommand() → { commandName: "commit", args: "fix typo" }
    ↓
processSlashCommand():
  ├─ hasCommand("commit")? → ✅
  ├─ getMessagesForSlashCommand():
  │   ├─ command.type === 'prompt' ?
  │   │   ├─ context === 'fork' ?
  │   │   │   → executeForkedSlashCommand() → 子 Agent 执行
  │   │   └─ getMessagesForPromptSlashCommand():
  │   │       ├─ command.getPromptForCommand(args, context)
  │   │       ├─ 注册 skill hooks（如有）
  │   │       ├─ 解析 allowedTools
  │   │       └─ 返回 { messages, shouldQuery: true, allowedTools }
  │   ├─ command.type === 'local' ?
  │   │   → mod.call(args, context) → LocalCommandResult
  │   └─ command.type === 'local-jsx' ?
  │       → mod.call(onDone, context, args) → 渲染 JSX UI
  └─ 返回给 REPL → shouldQuery=true 时触发 query()
```

### 五、远程模式安全过滤

```
REMOTE_SAFE_COMMANDS（远程模式白名单）:
  session, exit, clear, help, theme, color, vim, cost, usage,
  copy, btw, feedback, plan, keybindings, statusline, stickers, mobile

BRIDGE_SAFE_COMMANDS（Bridge 白名单）:
  compact, clear, cost, summary, releaseNotes, files
  + 所有 prompt 类型命令自动安全
  - 所有 local-jsx 命令自动不安全（Ink UI 无法远程渲染）
```

---

## 附录 E：技能系统 (Skill) 与插件系统 (Plugin) 全面分析

### 一、技能的本质

**技能 = 一个 type='prompt' 的 Command 对象**。它本质上是一段预定义的 prompt 模板，调用时扩展到对话中（inline）或在子 Agent 中执行（fork）。

### 二、技能来源（4 种）

| 来源 | 目录 | 注册方式 | loadedFrom |
|---|---|---|---|
| **捆绑技能** | 编译在 CLI 中 | `registerBundledSkill()` | `'bundled'` |
| **用户技能** | `~/.claude/skills/` | 文件系统扫描 | `'skills'` |
| **项目技能** | `.claude/skills/` | 文件系统扫描 | `'skills'` |
| **插件技能** | 插件包内 | 插件加载 | `'plugin'` |
| **MCP 技能** | MCP 服务器 | MCP 协议 | `'mcp'` |

### 三、文件技能格式（SKILL.md）

```
~/.claude/skills/my-skill/
└── SKILL.md
```

```markdown
---
description: "Do something useful"
whenToUse: "When user needs X"
allowedTools: ["Bash", "FileEdit"]
context: fork           # inline(默认) 或 fork
agent: general-purpose  # fork 时使用的 Agent 类型
argumentHint: "<file>"
hooks:
  PreToolUse:
    - matcher: "Bash"
      hook: "validate.sh"
---

# Instructions

Your task is to ${ARGUMENTS}...
Base directory: ${CLAUDE_SKILL_DIR}
Session: ${CLAUDE_SESSION_ID}
```

变量替换：
- `${ARGUMENTS}` → 用户传入的参数
- `${CLAUDE_SKILL_DIR}` → 技能所在目录
- `${CLAUDE_SESSION_ID}` → 当前会话 ID

### 四、捆绑技能清单（15+）

| 技能 | 说明 | 门控 |
|---|---|---|
| **update-config** | 更新配置 | - |
| **keybindings** | 快捷键管理 | - |
| **verify** | 验证代码 | - |
| **debug** | 调试辅助 | - |
| **lorem-ipsum** | 生成占位文本 | - |
| **skillify** | 创建新技能 | - |
| **remember** | 记忆管理 | - |
| **simplify** | 代码简化 | - |
| **batch** | 并行任务编排 | - |
| **stuck** | 解决卡住问题 | - |
| **dream** | 每夜记忆蒸馏 | `KAIROS \| KAIROS_DREAM` |
| **hunter** | 代码审查工件 | `REVIEW_ARTIFACT` |
| **loop** | 循环任务 | `AGENT_TRIGGERS` |
| **schedule-remote-agents** | 远程 Agent 调度 | `AGENT_TRIGGERS_REMOTE` |
| **claude-api** | Claude API 交互 | `BUILDING_CLAUDE_APPS` |
| **claude-in-chrome** | Chrome 扩展 | 自动检测 |

### 五、技能发现（实时文件监控）

```typescript
// skillChangeDetector.ts — chokidar 文件监控
监控目录: ~/.claude/skills/, .claude/skills/, .claude/commands/
监控深度: 2（skill-name/SKILL.md）
稳定阈值: 1000ms
防抖: 300ms

文件变更 → handleChange() → scheduleReload() (debounced)
  → clearSkillCaches() + clearCommandsCache()
  → 下次 getCommands() 自动重新加载
```

### 六、插件系统

#### 插件类型定义

```typescript
type PluginManifest = {
  name: string
  version: string
  description: string
  repository: string
  commands?: Record<string, CommandDef>
  skills?: Record<string, SkillDef>
  hooks?: HooksSettings
}
```

#### 插件生命周期

```
发现 → 安装 → 加载 → 激活
  │       │       │       │
  │       │       │       └─ 注册命令/技能/hooks
  │       │       └─ loadPluginCommands()（子进程隔离）
  │       └─ initializeVersionedPlugins()
  └─ getPluginSeedDirs()
```

#### 插件目录

| 目录 | 用途 |
|---|---|
| `~/.claude/plugins/` | 用户安装的插件 |
| `plugins/bundled/` | 内置插件 |
| 插件缓存 | 版本化缓存，孤儿清理 |

#### 插件版本管理

```typescript
// installedPluginsManager.ts
initializeVersionedPlugins():
  → 扫描已安装插件
  → 版本比较
  → 缓存管理
  → cleanupOrphanedPluginVersionsInBackground()
```

### 七、技能 vs 插件 vs 命令的关系

```
                    ┌─────────────────┐
                    │    Command      │ ← 统一类型
                    │  (union type)   │
                    └────────┬────────┘
              ┌──────────────┼──────────────┐
              │              │              │
     PromptCommand    LocalCommand   LocalJSXCommand
     (= 技能)         (= 本地命令)    (= UI 命令)
              │
    ┌─────────┼─────────┐
    │         │         │
 捆绑技能  文件技能  插件技能
 (bundled)  (.md)    (plugin)
```

**关键区别**：
- **技能** = PromptCommand，扩展为 prompt 给模型
- **插件** = 第三方包，可提供命令 + 技能 + hooks
- **命令** = 统一容器类型，包含技能和非技能命令

### 八、SkillTool —— 模型调用技能的桥梁

```
模型决定调用技能
    ↓
SkillTool.call({ skill_name: "verify", ... })
    ↓
findCommand("verify") → PromptCommand
    ↓
command.context === 'fork' ?
  ├─ 是 → runAgent() 子 Agent 执行
  └─ 否 → command.getPromptForCommand() 内联扩展
    ↓
返回 ToolResult → 注入消息流
```

---

## 七、阅读建议

1. **不要试图逐文件阅读** — 1900+ 文件，按路线选择性深入
2. **从类型定义入手** — `types/` 目录是理解数据模型的最佳起点
3. **关注 Tool.ts** — `ToolUseContext` 是连接所有子系统的枢纽类型
4. **利用特性门控标记** — `feature('XXX')` 和 `USER_TYPE === 'ant'` 帮你区分公开/内部功能
5. **query.ts 是核心** — 理解了查询循环，就理解了 Claude Code 的工作原理
6. **善用搜索** — 项目中的 `logEvent()` 调用揭示了所有重要的业务事件
