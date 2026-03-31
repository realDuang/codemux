# CodeMux 改进计划：基于 Claude Code 源码分析

> 基于对 Claude Code v2.1.88 内部实现的深度分析，结合 CodeMux 多引擎架构约束，提出的功能改进方案。
> 所有建议严格遵循 CodeMux 的 engine-agnostic 前端原则：前端只通过 `NormalizedToolName` 和 `EngineCapabilities` 做渲染分派，不按 `engineType` 分支。

## 变更层级定义

| 层级 | 含义 | 跨引擎风险 |
|---|---|---|
| **A（Adapter 层）** | 仅修改特定 engine adapter，不涉及统一类型或前端 | 零 |
| **B（统一类型扩展）** | 扩展 `unified.ts` 的 optional 字段或 capability flag | 低（不填充的 adapter 零影响） |
| **C（前端功能）** | 修改前端组件，但通过统一类型/capability 门控 | 中（需确保所有引擎兼容） |

---

## A 类：纯 Adapter 层改动（零跨引擎风险）

### A1. Claude 工具映射补全

**文件**: `src/types/tool-mapping.ts`

当前 `CLAUDE_TOOL_MAP` 缺少多个 Claude Code 实际使用的工具，导致它们全部映射为 `"unknown"`：

```typescript
// 当前缺失，建议补充：
const CLAUDE_TOOL_MAP = {
  ...existing,
  PowerShell: "shell",    // CC 在 Windows 上用 PowerShell 替代 Bash
  FileWrite: "write",     // CC 的 FileWriteTool（当前只映射了 Write，没有 FileWrite）
  WebSearch: "web_fetch", // CC 原生搜索工具
  NotebookEdit: "edit",   // Jupyter notebook 编辑
};
```

**工作量**: ~30 分钟
**验证**: 在 Windows 环境运行 Claude Code 会话，确认 PowerShell 工具不再显示为 unknown

### A2. Claude adapter 错误分类增强

**文件**: `electron/main/engines/claude/index.ts`

Claude Code 内部区分多种可恢复错误（见源码分析的 query.ts 章节），并且有自动恢复机制。当 adapter 收到 SDK 错误事件时：

- 在 `UnifiedMessage.error` 中附带结构化信息（如 `"[rate_limited] Please wait..."` 而非原始 stack trace）
- max_output_tokens 截断时，确保截断的文本不会被吞掉（SDK 可能在 error 事件前已发送部分内容）

**工作量**: ~3 小时

### A3. Claude adapter 的 permission diff 填充

**文件**: `electron/main/engines/claude/index.ts`

Claude Code 的 `FileEditTool` 在权限请求中包含 diff 预览。确保从 SDK 的 permission event 中提取 diff 内容，填入 `UnifiedPermission.diff` 字段。当前可能只填充了 `title` 和 `rawInput`。

**工作量**: ~1 小时
**验证**: 触发一个文件编辑权限请求，确认权限弹窗能看到 diff

---

## B 类：统一类型扩展

### B1. 新增 NormalizedToolName: `"web_search"`

**文件**: `src/types/unified.ts`, `src/types/tool-mapping.ts`, `src/components/share/part.tsx`

**动机**: 当前 `WebSearch`（Claude）和 `web_search`（Copilot）都映射到 `"web_fetch"`，但行为很不同：
- `web_search` 返回多条搜索结果摘要
- `web_fetch` 返回单个页面的完整内容

**变更**:
1. `unified.ts`: `NormalizedToolName` 联合类型新增 `"web_search"`
2. `tool-mapping.ts`:
   - Claude: `WebSearch → "web_search"`
   - Copilot: `web_search → "web_search"`
   - OpenCode: 暂无映射（将来可扩展）
3. `part.tsx`: 为 `"web_search"` 添加渲染分支（搜索结果列表样式，区别于 web_fetch 的页面预览）
4. `ContextGroup.tsx`: `CONTEXT_TOOLS` set 中添加 `"web_search"`

**兼容性**: 不支持的引擎永远不会产生此 normalizedTool，零影响。

**工作量**: ~2 小时

### B2. EngineCapabilities 新增 `costTracking: boolean`

**文件**: `src/types/unified.ts`, 各 adapter

**动机**: `cost` 字段在所有引擎的 `UnifiedMessage` 上都是 optional，但含义不同：
- Claude: USD token 计价
- OpenCode: USD token 计价（有 provider 定价表）
- Copilot: Premium Requests（非 USD）

**变更**:
1. `EngineCapabilities` 新增 `costTracking: boolean`
2. Claude adapter: `costTracking: true`
3. OpenCode adapter: `costTracking: true`
4. Copilot adapter: `costTracking: false`
5. 前端根据 flag 决定是否在消息上显示费用 badge

**兼容性**: 新增 optional capability，不影响现有行为。

**工作量**: ~2 小时

### B3. UnifiedMessage 新增 `activityDescription?: string`

**文件**: `src/types/unified.ts`, 各 adapter

**动机**: Claude Code 的每个工具都有 `getActivityDescription()`，返回如 "Reading src/foo.ts"、"Running bun test" 的人类可读描述。当前 `ToolPart.title` 已部分承担此角色，但质量参差不齐。

**变更**:
1. 各 adapter 负责从 SDK 事件中提取更好的 activity description
2. 前端 spinner/进度区域优先使用 `activityDescription`，fallback 到 `title`

**兼容性**: optional 字段，不填充的 adapter 零影响。

**工作量**: ~3 小时

---

## C 类：前端功能改动（通过统一类型/capability 门控）

### C1. Context Compaction 可视化

**文件**: `src/components/SessionTurn.tsx`

**当前状态**: `isCompaction` 字段已存在于 `UnifiedMessage`，`SessionTurn.tsx:320` 已检测但只是静默处理。

**变更**: 在 compaction 消息处渲染一个折叠分隔线，如 "⟳ 上下文已压缩"，帮助用户理解为什么对话历史被截断。

**兼容性**: ✅ 只要 `isCompaction === true` 就渲染，引擎无关（OpenCode 和 Claude 都会产生 compaction 消息）。

**工作量**: ~1 小时

### C2. Permission Dialog 的 diff 渲染

**文件**: `src/components/PermissionDialog.tsx`（或相关权限 UI 组件）

**当前状态**: `UnifiedPermission.diff` 字段已是统一类型，但前端可能只显示 `title`。

**变更**: 当 `diff` 有值时，在权限弹窗中用 shiki（项目已有依赖）渲染 diff 预览，让用户看到具体要修改什么再做决定。

**兼容性**: ✅ 所有引擎都可填充 `diff`（OpenCode 已有 diff 支持，Claude 可通过 A3 增强，Copilot 的 edit 权限也可补充）。

**工作量**: ~2 小时

### C3. Queued Messages UI 增强

**文件**: `src/stores/message.ts`, 相关 UI 组件

**当前状态**: `messageEnqueue` capability 已存在，`QueuedMessage` 类型已定义。

**变更**:
- 显示排队消息的文本预览（当前可能只有计数）
- 允许取消排队中的消息
- 显示排队位置（"#2 in queue"）

**兼容性**: ✅ 通过 `messageEnqueue` capability 门控，不支持的引擎不显示。

**工作量**: ~2 小时

---

## 暂不建议的改动

| 建议 | 不推荐原因 |
|---|---|
| 子 Agent 嵌套可视化 | 只有 CC 有完整多层 Agent 系统。需要设计 `AgentPart` 统一类型然后三个 adapter 都适配，ROI 不确定 |
| Plan Mode 特殊 UI | 三个引擎 mode 语义差异大（CC=权限切换，OpenCode=provider 行为，Copilot=全局模式），不适合 mode-specific UI |
| Channel 权限远程审批 | 需要定义跨引擎权限转发协议，当前 Channel 只做消息转发 |
| 会话分叉 | 只有 CC 有完善的 session fork，其他引擎需各自实现 |

---

## 实施优先级

```
第一优先级（低风险高收益）:
  A1 Claude 工具映射补全        — 30 分钟
  A3 Permission diff 填充       — 1 小时
  C1 Compaction 分隔线          — 1 小时

第二优先级（小范围类型扩展 + UI）:
  B1 新增 web_search 工具类型   — 2 小时
  C2 Permission diff 渲染       — 2 小时
  B2 costTracking capability    — 2 小时

第三优先级（增强体验）:
  B3 activityDescription        — 3 小时
  A2 错误分类增强               — 3 小时
  C3 Queued Messages UI         — 2 小时
```

总估计工作量: ~16.5 小时
