# Claude Code v2.1.88 源码分析

> 基于 npm 包 `@anthropic-ai/claude-code` 的 sourcemap 还原的 TypeScript 源码深度分析。
> 版本 2.1.88，共计 1902 个源文件（1332 `.ts` + 552 `.tsx` + 18 `.js`），基于 React + Ink 构建。

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

## 二、核心数据流：用户输入到 AI 响应

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

## 三、核心消息循环（query.ts，~1730 行）

### 架构：AsyncGenerator 状态机

`query()` 是一个 `async function*`，内部是 `while(true)` 循环。每次迭代 = 一个 turn（API 调用 + 工具执行）。

### 单次 Turn 完整流程

```
┌─────────────────────────────────────────────────────────────┐
│                    while(true) 循环体                        │
│                                                              │
│  ① 预处理阶段（消息准备）                                      │
│  ├─ getMessagesAfterCompactBoundary()                        │
│  ├─ applyToolResultBudget() — 工具结果大小预算控制              │
│  ├─ snipCompactIfNeeded()   — 裁剪旧消息                     │
│  ├─ microcompact()          — 微压缩                          │
│  └─ autocompact()           — 自动压缩                        │
│                                                              │
│  ② 上下文窗口溢出检测                                          │
│                                                              │
│  ③ API 流式调用 + 流式工具执行                                  │
│  ├─ deps.callModel({ messages, systemPrompt, tools, ... })   │
│  ├─ 收集 AssistantMessage + tool_use blocks                  │
│  ├─ streamingToolExecutor.addTool() — API 传输中即启动工具     │
│  └─ 扣留可恢复错误（prompt-too-long, max_output_tokens）      │
│                                                              │
│  ④ 分支判断: needsFollowUp?                                  │
│                                                              │
│  needsFollowUp = false → 错误恢复 / stop hooks / 完成        │
│  needsFollowUp = true  → 执行工具 → 注入附件 → continue       │
└─────────────────────────────────────────────────────────────┘
```

### 循环的 7 种 continue 原因

| reason | 触发条件 |
|---|---|
| `next_turn` | 工具执行完毕，正常继续 |
| `collapse_drain_retry` | 排空上下文折叠后重试 |
| `reactive_compact_retry` | 响应式压缩后重试 |
| `max_output_tokens_escalate` | 升级 8k→64k 重试 |
| `max_output_tokens_recovery` | 注入恢复消息后重试（最多3次） |
| `stop_hook_blocking` | 注入 hook 错误消息后重试 |
| `token_budget_continuation` | token 预算未用完 |

### 循环的终止原因

`completed` / `blocking_limit` / `prompt_too_long` / `image_error` / `model_error` / `aborted_streaming` / `aborted_tools` / `hook_stopped` / `stop_hook_prevented` / `max_turns`

### 工具并发控制

```
工具被分成批次:
  concurrency-safe 的工具 → 同一批次并行执行（最多10个）
  非 concurrency-safe 的工具 → 单独批次串行执行

Batch 1: [GrepTool, GlobTool, FileReadTool]  → 并行
Batch 2: [BashTool]                           → 串行（独占）
Batch 3: [FileReadTool, FileReadTool]         → 并行
Batch 4: [FileEditTool]                       → 串行（独占）
```

### 错误恢复机制

**Prompt-too-long（3 级瀑布）**：
1. Context Collapse drain → 2. Reactive Compact → 3. 放弃

**Max-output-tokens（3 级瀑布）**：
1. 升级 8k→64k → 2. 注入 "Resume directly" 消息（最多3次）→ 3. 放弃

**模型回退**：FallbackTriggeredError → 切换 fallbackModel → 丢弃已收集消息（发 tombstone）→ 重试

## 四、工具系统（40+ 内置工具）

### Tool 接口核心方法

```typescript
type Tool = {
  name: string
  aliases?: string[]
  shouldDefer?: boolean              // 是否延迟加载
  isConcurrencySafe(input): boolean  // 能否并行
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  validateInput?(input, ctx): ValidationResult
  checkPermissions(input, ctx): PermissionResult
  call(args, ctx, canUseTool, msg, onProgress?): ToolResult<Output>
  maxResultSizeChars: number         // 超过则持久化到磁盘
}
```

### 完整工具清单

#### 核心文件/代码操作
| 工具 | 并发 | 只读 | 延迟 |
|---|---|---|---|
| BashTool | ✅ | 按命令 | ❌ |
| PowerShellTool | ✅ | 按命令 | ❌ |
| FileReadTool | ✅ | ✅ | ❌ |
| FileEditTool | ✅ | ❌ | ❌ |
| FileWriteTool | ✅ | ❌ | ❌ |
| NotebookEditTool | ✅ | ❌ | ✅ |
| GrepTool / GlobTool | ✅ | ✅ | ❌ |

#### 搜索 & 网络
| 工具 | 并发 | 只读 | 延迟 |
|---|---|---|---|
| WebFetchTool | ✅ | ✅ | ✅ |
| WebSearchTool | ✅ | ✅ | ✅ |
| LSPTool | - | ✅ | ✅ |
| ToolSearchTool | ✅ | ✅ | ❌ |

#### 多 Agent & 任务
| 工具 | 说明 |
|---|---|
| AgentTool | 子 Agent 生成（fork/resurrection/async） |
| SkillTool | 技能调用 |
| TaskCreate/Get/List/Update/Output/Stop | 任务管理系统 |
| TeamCreate/Delete/SendMessage | Agent 团队（Swarm 模式） |

#### 交互 & 模式
| 工具 | 说明 |
|---|---|
| AskUserQuestionTool | 多选/单选 UI（最多4题×4选项） |
| EnterPlanMode/ExitPlanMode | Plan 模式切换 |
| EnterWorktree/ExitWorktree | Git worktree 隔离 |
| TodoWriteTool | Todo 列表 |
| BriefTool (SendUserMessage) | KAIROS 模式输出通道 |
| ConfigTool | 配置读写（ANT-only） |

### ToolSearch 延迟加载系统

初始 prompt 只包含 ~15 个核心工具 schema + ToolSearch。
其余工具需要模型先调用 `ToolSearch("select:WebFetch")` 加载 schema 后才可调用。

搜索评分：MCP 工具名精确 12 分 > 内置工具名 10 分 > searchHint 4 分 > description 2 分。

### 权限矩阵

| 矩阵 | 说明 |
|---|---|
| ALL_AGENT_DISALLOWED_TOOLS | 所有子 Agent 禁用：TaskOutput, PlanMode, AskUser, TaskStop |
| ASYNC_AGENT_ALLOWED_TOOLS | 异步 Agent 白名单：File*, Grep, Glob, Shell, Web*, Skill 等 |
| COORDINATOR_MODE_ALLOWED_TOOLS | 协调者仅限：Agent, TaskStop, SendMessage |
| IN_PROCESS_TEAMMATE_ALLOWED_TOOLS | 队友额外：TaskCRUD, SendMessage, Cron |

## 五、命令系统（100+ 斜杠命令）

### 三种命令类型

| 类型 | 特点 | 示例 |
|---|---|---|
| PromptCommand | 扩展为 prompt 给模型，支持 inline/fork | `/commit`, `/review`, 所有 skills |
| LocalCommand | 本地同步执行，返回文本 | `/clear`, `/cost`, `/vim` |
| LocalJSXCommand | 渲染 Ink React UI | `/config`, `/model`, `/resume` |

### 命令来源（7 个，合并去重）

内置命令 + 捆绑技能 + 用户技能 + 插件命令 + 插件技能 + MCP 命令 + 工作流命令

### 关键命令分类

- **会话**: `/resume` `/clear` `/compact` `/branch` `/rename`
- **Git**: `/commit` `/commit-push-pr` `/review` `/diff`
- **配置**: `/config` `/model` `/effort` `/theme` `/permissions`
- **工具**: `/mcp` `/ide` `/plugin` `/skills` `/tasks` `/hooks`
- **帮助**: `/help` `/status` `/doctor` `/cost` `/usage`

## 六、技能系统

技能 = PromptCommand，本质是预定义 prompt 模板 + 元数据。

### 技能来源
| 来源 | 目录 | loadedFrom |
|---|---|---|
| 捆绑技能 | CLI 内置 | `'bundled'` |
| 用户技能 | `~/.claude/skills/` | `'skills'` |
| 项目技能 | `.claude/skills/` | `'skills'` |
| 插件技能 | 插件包内 | `'plugin'` |
| MCP 技能 | MCP 服务器 | `'mcp'` |

### 捆绑技能（15+）
verify, debug, remember, simplify, skillify, batch, stuck, update-config, keybindings, lorem-ipsum, dream（KAIROS）, hunter（REVIEW_ARTIFACT）, loop（AGENT_TRIGGERS）等

### 文件技能格式（SKILL.md）
YAML frontmatter（description, allowedTools, context, hooks 等）+ Markdown body，支持 `${ARGUMENTS}` / `${CLAUDE_SKILL_DIR}` 变量替换。

## 七、KAIROS (Assistant Mode)

KAIROS 是 Claude Code 的远程 Agent 守护进程模式。由于外部构建中 `feature('KAIROS')` 为 false，核心实现文件被死代码消除。

### 7 个关联 Feature Flag
`KAIROS` / `KAIROS_BRIEF` / `KAIROS_PUSH_NOTIFICATION` / `KAIROS_GITHUB_WEBHOOKS` / `KAIROS_CHANNELS` / `KAIROS_DREAM` / `PROACTIVE`

### 关键子系统
- **Channel 系统**：通过 MCP 接入 Slack/Discord/Telegram，支持手机端权限审批
- **记忆范式**：KAIROS 用 append-only 每日日志 + 每夜 `/dream` 蒸馏（替代普通的 MEMORY.md）
- **专属工具**：SleepTool, SendUserMessage, SendUserFileTool, PushNotificationTool, SubscribePRTool
- **进程内多 Agent 团队**：`initializeAssistantTeam()` 预种子，无需 TeamCreate

## 八、关键设计模式

| 模式 | 说明 |
|---|---|
| Feature Gating（三层） | 编译时 `feature()` / 运行时 GrowthBook / 环境变量 |
| 延迟加载 | `const X = feature('F') ? require('./X.js') : null` 打破循环依赖 + DCE |
| 自定义 Store | `createStore()` + `useSyncExternalStore` 替代 Redux |
| 权限模型 | Deny > Allow > 模式默认行为（bypass/auto/default） |
| Prompt Cache 稳定性 | 工具池按名排序 + 消息不可变（clone-on-yield） |
| 磁盘流式输出 | 任务输出写磁盘文件，按偏移量增量读取，避免 OOM |

## 九、目录规模

| 目录 | 文件数 | 说明 |
|---|---|---|
| utils/ | 564 | 基础工具库 |
| components/ | 389 | UI 组件 |
| commands/ | 207 | 斜杠命令 |
| tools/ | 184 | 内置工具 |
| services/ | 130 | 服务层 |
| hooks/ | 104 | React Hooks |
| ink/ | 96 | 终端渲染 |
| 其他 | ~228 | bridge, constants, skills, cli 等 |
