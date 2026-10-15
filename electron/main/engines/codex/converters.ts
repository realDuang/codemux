import { posix, win32 } from "node:path";
import { timeId } from "../../utils/id-gen";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import { mimeToFileExtension } from "../../../../shared/image-limits";
import type {
  FilePart,
  MessagePromptContent,
  NormalizedToolName,
  PermissionDetail,
  PermissionOption,
  ReasoningEffort,
  ReasoningPart,
  StepFinishPart,
  StepStartPart,
  SystemNoticePart,
  TextPart,
  ToolDisplayAction,
  ToolPart,
  UnifiedMessage,
  UnifiedPart,
  UnifiedPermission,
  UnifiedQuestion,
} from "../../../../src/types/unified";
import type { MessageBuffer } from "../engine-adapter";
import { normalizeCodexResponseContent } from "./response-content";
import { extractCodexToolOutput } from "./tool-output";
import { withCodexAssistantImages } from "./assistant-images";
import { formatCodexAsyncQuestionReplies, getCodexAsyncQuestions, parseCodexAsyncQuestionReplies } from "./async-questions";

interface CodexUserInput {
  type?: string;
  text?: string;
  url?: string;
  path?: string;
  name?: string;
}

interface CodexThreadItem {
  id?: string;
  type?: string;
  text?: string;
  content?: unknown;
  summary?: string[];
  phase?: string | null;
  memoryCitation?: unknown;
  name?: string;
  output?: unknown;
  delivery?: string | null;
  questions?: unknown;
  command?: string;
  cwd?: string;
  processId?: string | null;
  status?: string;
  commandActions?: Array<Record<string, unknown>>;
  parsedCmd?: unknown;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<Record<string, unknown>>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  contentItems?: unknown[] | null;
  success?: boolean | null;
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  receiverThreadIds?: string[];
  senderThreadId?: string;
  agentsStates?: Record<string, unknown>;
  query?: string;
  action?: unknown;
  path?: string;
  revisedPrompt?: string | null;
  savedPath?: string;
  review?: string;
  fragments?: unknown[];
}

interface CodexThreadTurn {
  id?: string;
  items?: CodexThreadItem[];
  status?: string;
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

interface CodexThreadReadResult {
  thread?: {
    id?: string;
    cwd?: string;
    createdAt?: string | number;
    updatedAt?: string | number;
    turns?: CodexThreadTurn[];
  };
}

interface CodexPlanStep {
  step?: string;
  status?: string;
}

export function upsertPart(parts: UnifiedPart[], part: UnifiedPart): void {
  const index = parts.findIndex((candidate) => candidate.id === part.id);
  if (index >= 0) {
    part.order ??= parts[index].order ?? index;
    parts[index] = part;
    return;
  }
  part.order ??= parts.length;
  parts.push(part);
}

export function codexItemPartId(buffer: MessageBuffer, itemId: string, suffix?: string): string {
  return ["part_codex", buffer.sessionId, buffer.activeTurnId ?? buffer.messageId, itemId, suffix ?? "item"]
    .map(encodeURIComponent).join(":");
}

export function upsertAgentMessage(
  buffer: MessageBuffer,
  itemId: string,
  text: string,
  options: { delta?: boolean; phase?: TextPart["phase"]; memoryCitation?: unknown; questions?: unknown; delivery?: unknown; completed?: boolean } = {},
): TextPart {
  const id = codexItemPartId(buffer, itemId);
  const existing = buffer.parts.find((part): part is TextPart => part.id === id && part.type === "text");
  const phase = options.phase ?? existing?.phase ?? (options.delivery === "async" ? "partial" : undefined);
  const part: TextPart = withCodexAssistantImages({
    id,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "text",
    ...normalizeCodexResponseContent(options.delta ? (existing?.text ?? "") + text : text, options.memoryCitation, options.questions),
    ...((options.completed ?? existing?.completed) !== undefined ? { completed: options.completed ?? existing?.completed } : {}),
    ...(phase ? { phase } : {}),
  }, buffer.engineMeta?.codexThreadId);
  upsertPart(buffer.parts, part);
  return part;
}

export function upsertAsyncQuestionReply(buffer: MessageBuffer, itemId: string, text: string): TextPart {
  const part: TextPart = {
    id: codexItemPartId(buffer, itemId), messageId: buffer.messageId, sessionId: buffer.sessionId,
    type: "text", text, completed: true, phase: "commentary",
  };
  upsertPart(buffer.parts, part);
  return part;
}

export function appendTextDelta(buffer: MessageBuffer, delta: string): TextPart {
  buffer.textAccumulator += delta;

  if (!buffer.leadingTrimmed) {
    const trimmed = buffer.textAccumulator.trimStart();
    if (!trimmed) {
      if (!buffer.textPartId) buffer.textPartId = timeId("part");
      return {
        id: buffer.textPartId,
        messageId: buffer.messageId,
        sessionId: buffer.sessionId,
        type: "text",
        text: "",
      };
    }

    buffer.textAccumulator = trimmed;
    buffer.leadingTrimmed = true;
  }

  if (!buffer.textPartId) buffer.textPartId = timeId("part");

  const textPart: TextPart = {
    id: buffer.textPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "text",
    text: buffer.textAccumulator,
  };
  upsertPart(buffer.parts, textPart);
  return textPart;
}

export function appendReasoningDelta(buffer: MessageBuffer, delta: string): ReasoningPart {
  buffer.reasoningAccumulator += delta;
  if (!buffer.reasoningPartId) buffer.reasoningPartId = timeId("part");

  const reasoningPart: ReasoningPart = {
    id: buffer.reasoningPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "reasoning",
    summaryFormat: "heading-prefixed",
    text: buffer.reasoningAccumulator,
  };
  upsertPart(buffer.parts, reasoningPart);
  return reasoningPart;
}

export function normalizeCodexReasoningText(summary: unknown, _content: unknown): string {
  // Native Desktop displays only public summary sections, never raw reasoning content.
  return extractReasoningBlocks(summary).join("\n\n");
}

function extractReasoningBlocks(value: unknown): string[] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap((block) => {
    let text = "";
    if (typeof block === "string") {
      text = block;
    } else if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      text = (block as { text: string }).text;
    }
    return text.trim() ? [text] : [];
  });
}

export function appendPlanDelta(buffer: MessageBuffer, delta: string, itemId?: string): TextPart {
  if (itemId) {
    const existing = buffer.parts.find((part) => part.id === codexItemPartId(buffer, itemId));
    return upsertAgentMessage(buffer, itemId, existing ? delta : formatPlanMarkdown(delta), {
      delta: true,
      phase: "partial",
    });
  }
  const prefix = "## Plan\n\n";
  const current = buffer.planAccumulator ?? prefix;
  buffer.planAccumulator = current + delta;

  if (!buffer.planPartId) buffer.planPartId = timeId("part");

  const part: TextPart = {
    id: buffer.planPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "text",
    text: buffer.planAccumulator,
  };
  upsertPart(buffer.parts, part);
  return part;
}

export function replacePlanText(buffer: MessageBuffer, markdown: string, itemId?: string): TextPart {
  if (itemId) return upsertAgentMessage(buffer, itemId, markdown, { phase: "partial" });
  buffer.planAccumulator = markdown;
  if (!buffer.planPartId) buffer.planPartId = timeId("part");

  const part: TextPart = {
    id: buffer.planPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "text",
    text: markdown,
    phase: "commentary",
  };
  upsertPart(buffer.parts, part);
  return part;
}

export function createSystemNotice(
  buffer: MessageBuffer,
  noticeType: SystemNoticePart["noticeType"],
  text: string,
): SystemNoticePart {
  const part: SystemNoticePart = {
    id: timeId("part"),
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "system-notice",
    order: buffer.parts.length,
    noticeType,
    text,
  };
  buffer.parts.push(part);
  return part;
}

export function formatTurnPlanMarkdown(
  explanation: string | null | undefined,
  plan: CodexPlanStep[],
): string {
  const lines: string[] = ["## Plan", ""];

  if (explanation?.trim()) {
    lines.push(explanation.trim(), "");
  }

  if (plan.length === 0) {
    lines.push("- No steps provided");
    return lines.join("\n");
  }

  for (const step of plan) {
    const text = typeof step.step === "string" && step.step.trim() ? step.step.trim() : "Untitled step";
    const marker = step.status === "completed"
      ? "[x]"
      : step.status === "inProgress"
        ? "[-]"
        : "[ ]";
    lines.push(`- ${marker} ${text}`);
  }

  return lines.join("\n");
}

export function buildToolTitle(
  itemType: string,
  normalizedTool: NormalizedToolName,
  params: Record<string, unknown>,
): string {
  switch (normalizedTool) {
    case "shell": {
      const command = typeof params.command === "string" ? params.command : "";
      return command ? `Running ${truncate(command, 72)}` : "Running command";
    }
    case "read": {
      const filePath = extractFilePath(params);
      return filePath ? `Reading ${filePath}` : "Reading file";
    }
    case "edit": {
      const filePath = extractFilePath(params);
      return filePath ? `Editing ${filePath}` : "Editing file";
    }
    case "web_fetch": {
      const url = typeof params.url === "string" ? params.url : undefined;
      const query = typeof params.query === "string" ? params.query : undefined;
      return url ? `Fetching ${truncate(url, 72)}` : query ? `Searching ${truncate(query, 72)}` : "Searching the web";
    }
    case "task": {
      const description = typeof params.description === "string" ? params.description : undefined;
      const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
      return description ?? (prompt ? `Delegating ${truncate(prompt, 72)}` : "Delegating task");
    }
    default: {
      if (typeof params.description === "string" && params.description) {
        return params.description;
      }
      if (typeof params.tool === "string" && params.tool) {
        return params.tool;
      }
      return itemType;
    }
  }
}

/** Preserve command details while exposing native exploration actions to the renderer. */
export function applyCodexToolDisplay(
  part: ToolPart,
  params: Record<string, unknown>,
  workingDirectory?: string,
): void {
  if (part.normalizedTool !== "shell") return;
  const input = {
    ...asRecord(part.state.input),
    ...Object.fromEntries(Object.entries(params).filter(([, value]) => value != null)),
  };
  const actions = normalizeCodexToolDisplayActions(input, workingDirectory);
  if (actions) part.displayActions = actions;
  part.title = buildToolTitle(part.originalTool, part.normalizedTool, input);
}

export function normalizeCodexToolDisplayActions(
  input: Record<string, unknown>,
  workingDirectory?: string,
): ToolDisplayAction[] | undefined {
  const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
  const command = text(input.command) ?? text(input.cmd);
  if (input.status === "declined") return command ? [{ kind: "shell", command }] : undefined;
  const cwd = text(input.cwd) ?? workingDirectory;
  const parsed = input.parsedCmd;
  const source = Array.isArray(input.commandActions) && input.commandActions.length > 0
    ? input.commandActions : parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
  const actions = source.flatMap((value): ToolDisplayAction[] => {
    const action = asRecord(value);
    const actionCommand = text(action.command) ?? text(action.cmd);
    const rawPath = text(action.path) ?? (action.type === "read" ? text(action.name) : undefined);
    const path = rawPath ? resolveToolDisplayPath(rawPath, cwd) : undefined;
    const details = { ...(path ? { path } : {}), ...(actionCommand ? { command: actionCommand } : {}) };
    switch (action.type) {
      case "read": {
        const skill = path ? skillNameFromDefinitionPath(path) : undefined;
        const label = text(action.displayLabel) ?? skill ?? text(action.name) ?? (path ? posix.basename(path.replaceAll("\\", "/")) : undefined);
        return [{ kind: skill ? "skill" : "read", ...details, ...(label ? { label } : {}) }];
      }
      case "search": {
        const query = text(action.query);
        return [{ kind: "search", ...details, ...(query ? { query } : {}) }];
      }
      case "listFiles":
      case "list_files":
        return [{ kind: "list", ...details }];
      case "unknown":
        return [{ kind: "shell", ...(actionCommand ?? command ? { command: actionCommand ?? command } : {}) }];
      default:
        return actionCommand ? [{ kind: "shell", command: actionCommand }] : [];
    }
  });
  return actions.length > 0 ? actions : command ? [{ kind: "shell", command }] : undefined;
}

function resolveToolDisplayPath(path: string, cwd?: string): string {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(path) || (cwd && /^[A-Za-z]:[\\/]|^\\\\/.test(cwd)) ? win32 : posix;
  return paths.isAbsolute(path) || !cwd ? paths.normalize(path) : paths.resolve(cwd, path);
}

function skillNameFromDefinitionPath(path: string): string | undefined {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  // A file named SKILL.md is only a skill definition inside a recognized skill root.
  for (let index = 0; index < segments.length; index++) {
    if (![".codex", ".agents"].includes(lower[index]) || lower[index + 1] !== "skills") continue;
    const root = index + (["_import", ".system"].includes(lower[index + 2]) ? 3 : 2);
    return segments.length === root + 2 && lower[root + 1] === "skill.md" ? segments[root] : undefined;
  }
  for (let index = 0; index < segments.length; index++) {
    if (lower[index] !== "plugins") continue;
    const cached = lower[index + 1] === "cache";
    const plugin = index + (cached ? 3 : 1);
    const pluginRoot = plugin + Number(cached);
    const skills = lower.findIndex((segment, offset) => offset > pluginRoot && segment === "skills");
    const root = skills < 0 ? pluginRoot : skills + 1;
    if (segments.length === root + 2 && lower[root + 1] === "skill.md") return segments[skills < 0 ? plugin : root];
  }
  return undefined;
}

export function createToolPart(
  buffer: MessageBuffer,
  callId: string,
  itemType: string,
  params: Record<string, unknown>,
): { stepStart: StepStartPart; toolPart: ToolPart } {
  const normalizedTool = normalizeToolName("codex", itemType);
  const input = normalizeToolInput(itemType, normalizedTool, params);
  const title = buildToolTitle(itemType, normalizedTool, input);

  const stepStart: StepStartPart = {
    id: codexItemPartId(buffer, callId, "start"),
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "step-start",
    order: buffer.parts.length,
  };

  const toolPart: ToolPart = {
    id: codexItemPartId(buffer, callId),
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "tool",
    order: buffer.parts.length + 1,
    callId,
    normalizedTool,
    originalTool: itemType,
    title,
    kind: inferToolKind(undefined, normalizedTool),
    state: {
      status: "running",
      input,
      time: { start: Date.now() },
    },
  };

  applyCodexToolDisplay(toolPart, input, buffer.workingDirectory);

  const filePath = extractFilePath(input);
  if (filePath) {
    toolPart.locations = [{ path: filePath }];
  }

  const diff = extractDiffFromParams(input);
  if (diff) toolPart.diff = diff;

  buffer.parts.push(stepStart, toolPart);
  return { stepStart, toolPart };
}

export function completeToolPart(
  toolPart: ToolPart,
  output: unknown,
  error?: string,
  metadata?: Record<string, unknown>,
): void {
  const startTime = toolPart.state.status === "running"
    ? toolPart.state.time.start
    : Date.now();
  const endTime = Date.now();
  const input = toolPart.state.status === "pending"
    ? toolPart.state.input ?? {}
    : toolPart.state.input;

  const outputText = stringifyOutput(output);
  const nextMetadata: Record<string, unknown> = { ...(metadata ?? {}) };

  if (toolPart.normalizedTool === "shell") {
    const accumulatedOutput = getRunningToolOutput(input);
    const shellOutput = outputText || accumulatedOutput || "";
    nextMetadata.output = shellOutput;
    nextMetadata.stdout = shellOutput;
  }

  if ((toolPart.normalizedTool === "edit" || toolPart.normalizedTool === "write") && toolPart.diff) {
    nextMetadata.diff = toolPart.diff;
  }

  if (error) {
    toolPart.state = {
      status: "error",
      input,
      output: outputText || undefined,
      error,
      time: {
        start: startTime,
        end: endTime,
        duration: endTime - startTime,
      },
    };
    return;
  }

  toolPart.state = {
    status: "completed",
    input,
    output: outputText,
    time: {
      start: startTime,
      end: endTime,
      duration: endTime - startTime,
    },
    metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
  };
}

export function createStepFinish(buffer: MessageBuffer, itemId?: string): StepFinishPart {
  const part: StepFinishPart = {
    id: itemId ? codexItemPartId(buffer, itemId, "finish") : timeId("part"),
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "step-finish",
    order: buffer.parts.length,
  };
  buffer.parts.push(part);
  return part;
}

export function convertApprovalToPermission(
  sessionId: string,
  requestId: number | string,
  method: string,
  params: unknown,
): UnifiedPermission {
  const data = asRecord(params);
  const options = buildPermissionOptions(method, data.availableDecisions);

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof data.command === "string" ? data.command : "";
    const details: PermissionDetail[] = [];
    if (command) details.push({ label: "Command", value: command, mono: true });
    if (typeof data.reason === "string" && data.reason) details.push({ label: "Reason", value: data.reason });
    return {
      id: String(requestId),
      sessionId,
      engineType: "codex",
      toolCallId: typeof data.itemId === "string" ? data.itemId : undefined,
      toolName: "shell",
      title: command ? `Approve command: ${truncate(command, 96)}` : "Approve command execution",
      kind: "other",
      details,
      rawInput: params,
      options,
      metadata: typeof data.reason === "string" && data.reason ? { reason: data.reason } : undefined,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const details: PermissionDetail[] = [];
    if (typeof data.grantRoot === "string" && data.grantRoot) details.push({ label: "Path", value: data.grantRoot, mono: true });
    if (typeof data.reason === "string" && data.reason) details.push({ label: "Reason", value: data.reason });
    return {
      id: String(requestId),
      sessionId,
      engineType: "codex",
      toolCallId: typeof data.itemId === "string" ? data.itemId : undefined,
      toolName: "edit",
      title: typeof data.reason === "string" && data.reason ? data.reason : "Approve file changes",
      kind: "edit",
      details,
      rawInput: params,
      options,
      metadata: typeof data.grantRoot === "string" && data.grantRoot ? { grantRoot: data.grantRoot } : undefined,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const permissions = asRecord(data.permissions);
    const fileSystem = asRecord(permissions.fileSystem);
    const hasWrite = Array.isArray(fileSystem.write) && fileSystem.write.length > 0;
    const hasRead = Array.isArray(fileSystem.read) && fileSystem.read.length > 0;
    const details: PermissionDetail[] = [];
    if (hasRead && Array.isArray(fileSystem.read)) details.push({ label: "Read", value: fileSystem.read.filter((v): v is string => typeof v === "string").join(", "), mono: true });
    if (hasWrite && Array.isArray(fileSystem.write)) details.push({ label: "Write", value: fileSystem.write.filter((v): v is string => typeof v === "string").join(", "), mono: true });
    if (typeof data.reason === "string" && data.reason) details.push({ label: "Reason", value: data.reason });

    return {
      id: String(requestId),
      sessionId,
      engineType: "codex",
      toolCallId: typeof data.itemId === "string" ? data.itemId : undefined,
      title: typeof data.reason === "string" && data.reason ? data.reason : "Approve additional permissions",
      kind: hasWrite ? "edit" : hasRead ? "read" : "other",
      details,
      rawInput: params,
      options,
    };
  }

  if (method === "execCommandApproval") {
    const command = Array.isArray(data.command)
      ? data.command.filter((value): value is string => typeof value === "string").join(" ")
      : "";
    const details: PermissionDetail[] = [];
    if (command) details.push({ label: "Command", value: command, mono: true });
    if (typeof data.reason === "string" && data.reason) details.push({ label: "Reason", value: data.reason });

    return {
      id: String(requestId),
      sessionId,
      engineType: "codex",
      toolCallId: typeof data.callId === "string" ? data.callId : undefined,
      toolName: "shell",
      title: command ? `Approve command: ${truncate(command, 96)}` : "Approve command execution",
      kind: "other",
      details,
      rawInput: params,
      options: [
        { id: "allow_once", label: "Allow", type: "allow_once" },
        { id: "allow_always", label: "Always Allow", type: "allow_always" },
        { id: "reject_once", label: "Deny", type: "reject_once" },
      ],
      metadata: typeof data.reason === "string" && data.reason ? { reason: data.reason } : undefined,
    };
  }

  if (method === "applyPatchApproval") {
    const fileChanges = asRecord(data.fileChanges);
    const diff = Object.values(fileChanges)
      .map((value) => asRecord(value))
      .map((change) => typeof change.diff === "string" ? change.diff : "")
      .filter(Boolean)
      .join("\n");
    const details: PermissionDetail[] = [];
    const changedFiles = Object.keys(fileChanges).filter(Boolean);
    if (changedFiles.length > 0) details.push({ label: "Files", value: changedFiles.join(", "), mono: true });
    if (typeof data.reason === "string" && data.reason) details.push({ label: "Reason", value: data.reason });

    return {
      id: String(requestId),
      sessionId,
      engineType: "codex",
      toolCallId: typeof data.callId === "string" ? data.callId : undefined,
      toolName: "edit",
      title: typeof data.reason === "string" && data.reason ? data.reason : "Approve file changes",
      kind: "edit",
      diff: diff || undefined,
      details,
      rawInput: params,
      options: [
        { id: "allow_once", label: "Allow", type: "allow_once" },
        { id: "allow_always", label: "Always Allow", type: "allow_always" },
        { id: "reject_once", label: "Deny", type: "reject_once" },
      ],
    };
  }

  return {
    id: String(requestId),
    sessionId,
    engineType: "codex",
    title: "Approve Codex action",
    kind: "other",
    details: [],
    rawInput: params,
    options: [
      { id: "allow_once", label: "Allow", type: "allow_once" },
      { id: "allow_always", label: "Always Allow", type: "allow_always" },
      { id: "reject_once", label: "Deny", type: "reject_once" },
    ],
  };
}

export function convertUserInputToQuestion(
  sessionId: string,
  requestId: number | string,
  params: unknown,
): UnifiedQuestion {
  const data = asRecord(params);
  const questions = Array.isArray(data.questions)
    ? data.questions
      .map((question) => asRecord(question))
      .map((question, index) => ({
        question:
          typeof question.question === "string" && question.question
            ? question.question
            : `Question ${index + 1}`,
        header:
          typeof question.header === "string" && question.header
            ? question.header
            : `Input ${index + 1}`,
        options: Array.isArray(question.options)
          ? question.options
            .map((option) => asRecord(option))
            .map((option) => {
              const label = typeof option.label === "string" ? option.label : "";
              if (!label) return null;
              return {
                label,
                description: typeof option.description === "string" ? option.description : "",
              };
            })
            .filter((option): option is { label: string; description: string } => option !== null)
          : [],
        multiple: false,
        custom: question.isOther !== false,
      }))
    : [];

  return {
    id: String(requestId),
    sessionId,
    engineType: "codex",
    toolCallId:
      typeof data.itemId === "string"
        ? data.itemId
        : undefined,
    questions: questions.length > 0
      ? questions
      : [{
          question: "Codex needs your input",
          header: "Input",
          options: [],
          multiple: false,
          custom: true,
        }],
    metadata: { rawParams: params },
  };
}

export function applyTurnUsage(buffer: MessageBuffer, usage: unknown): void {
  const data = asRecord(usage);
  if (Object.keys(data).length === 0) return;

  const source = asRecord(data.last ?? data.total ?? usage);
  if (Object.keys(source).length === 0) return;

  const input = toNumber(source.inputTokens) ?? toNumber(source.input_tokens) ?? 0;
  const output = toNumber(source.outputTokens) ?? toNumber(source.output_tokens) ?? 0;
  const cacheRead = toNumber(source.cachedInputTokens) ?? toNumber(source.cacheReadInputTokens) ?? toNumber(source.cache_read_input_tokens);
  const reasoning = toNumber(source.reasoningOutputTokens) ?? toNumber(source.reasoning_output_tokens);

  buffer.tokens = {
    input,
    output,
    ...(cacheRead != null
      ? {
          cache: {
            read: cacheRead,
            write: 0,
          },
        }
      : {}),
    ...(reasoning != null ? { reasoning } : {}),
  };
}

export function applyTurnMetadata(buffer: MessageBuffer, turn: Record<string, unknown>): void {
  if (typeof turn.model === "string" && turn.model) {
    buffer.modelId = turn.model;
  }

  if (typeof turn.reasoningEffort === "string") {
    buffer.reasoningEffort = normalizeHistoricalEffort(turn.reasoningEffort);
  }

  if (typeof turn.effort === "string") {
    buffer.reasoningEffort = normalizeHistoricalEffort(turn.effort);
  }

  const costUsd = toNumber(turn.costUsd) ?? toNumber(turn.costUSD);
  if (costUsd != null) {
    buffer.cost = costUsd;
    buffer.costUnit = "usd";
  }

  if (typeof turn.id === "string") {
    buffer.activeTurnId = turn.id;
  }

  const diff = typeof turn.diff === "string" ? turn.diff : undefined;
  if (diff) {
    buffer.engineMeta = {
      ...(buffer.engineMeta ?? {}),
      turnDiff: diff,
    };
  }
}

export function finalizeBufferToMessage(buffer: MessageBuffer): UnifiedMessage {
  buffer.parts.forEach((part, index) => { part.order ??= index; });
  return {
    id: buffer.messageId,
    sessionId: buffer.sessionId,
    role: "assistant",
    time: {
      created: buffer.startTime,
      completed: Date.now(),
    },
    parts: buffer.parts,
    tokens: buffer.tokens,
    cost: buffer.cost,
    costUnit: buffer.costUnit,
    modelId: buffer.modelId,
    reasoningEffort: buffer.reasoningEffort,
    error: buffer.error,
    workingDirectory: buffer.workingDirectory,
    engineMeta: buffer.engineMeta,
  };
}

export function createUserMessage(
  sessionId: string,
  text: string,
  createdAt = Date.now(),
  images: MessagePromptContent[] = [],
): UnifiedMessage {
  const messageId = timeId("msg");
  const parts: Array<TextPart | FilePart> = [];
  let partIdx = 0;
  let imageIdx = 0;

  if (text) {
    parts.push({
      id: `${messageId}_p${partIdx++}`,
      messageId,
      sessionId,
      type: "text",
      text,
    });
  }

  for (const c of images) {
    if (c.type !== "image" || !c.data) continue;
    const mime = c.mimeType || "image/png";
    const ext = mimeToFileExtension(mime);
    parts.push({
      id: `${messageId}_p${partIdx++}`,
      messageId,
      sessionId,
      type: "file",
      mime,
      filename: `image-${++imageIdx}.${ext}`,
      url: `data:${mime};base64,${c.data}`,
    });
  }

  if (parts.length === 0) {
    parts.push({
      id: `${messageId}_p${partIdx}`,
      messageId,
      sessionId,
      type: "text",
      text: "",
    });
  }

  parts.forEach((part, index) => { part.order = index; });
  return {
    id: messageId,
    sessionId,
    role: "user",
    time: { created: createdAt, completed: createdAt },
    parts,
  };
}

export function convertThreadToMessages(
  sessionId: string,
  result: CodexThreadReadResult,
  workingDirectory?: string,
): UnifiedMessage[] {
  const thread = result.thread;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages: UnifiedMessage[] = [];
  const threadStart = toMillis(thread?.createdAt, Date.now());

  turns.forEach((turn, turnIndex) => {
    const turnId = turn.id ?? `turn-${turnIndex}`;
    const messagePrefix = ["msg_codex", sessionId, turnId].map(encodeURIComponent).join(":");
    const nativeCreatedAt = toMillis(turn.startedAt ?? undefined, threadStart + turnIndex * 2);
    const previousCreatedAt = messages.at(-1)?.time.created;
    const createdAt = previousCreatedAt == null ? nativeCreatedAt : Math.max(nativeCreatedAt, previousCreatedAt + 1);
    const completedAt = toMillis(turn.completedAt ?? undefined, createdAt + (turn.durationMs ?? 1));
    const inProgress = turn.status === "inProgress";
    const items = Array.isArray(turn.items) ? turn.items : [];
    const asyncQuestionIds = new Set(items.flatMap(getCodexAsyncQuestions).map((question) => question.id));
    let messageIndex = 0;
    const createBuffer = (suffix = "assistant"): MessageBuffer => ({
      messageId: `${messagePrefix}:${suffix}`,
      sessionId,
      parts: [],
      textAccumulator: "",
      textPartId: null,
      reasoningAccumulator: "",
      reasoningPartId: null,
      planAccumulator: undefined,
      planPartId: null,
      startTime: createdAt,
      workingDirectory: workingDirectory ?? thread?.cwd,
      activeTurnId: turnId,
      engineMeta: {
        ...(thread?.id ? { codexThreadId: thread.id } : {}),
        ...(turn.id ? { codexTurnId: turn.id } : {}),
        codexTurnStatus: turn.status,
      },
    });
    let buffer = createBuffer();

    const appendAssistant = (lastSegment: boolean): boolean => {
      if (lastSegment && (turn.status === "failed" || turn.status === "interrupted")) {
        buffer.error = normalizeError(turn.error) ?? (turn.status === "interrupted" ? "Turn interrupted" : "Turn failed");
      }
      if (buffer.parts.length === 0 && !buffer.error && !(lastSegment && inProgress)) return false;
      // Native items have no timestamps. Keep their order within the turn's first millisecond.
      const segmentCreatedAt = createdAt + messageIndex++ / (items.length + 1);
      messages.push({
        ...finalizeBufferToMessage(buffer),
        time: {
          created: segmentCreatedAt,
          ...(!inProgress || !lastSegment ? { completed: Math.max(segmentCreatedAt, completedAt) } : {}),
        },
      });
      return true;
    };

    items.forEach((item, itemIndex) => {
      const itemId = item.id ?? `call-${itemIndex}`;
      if (item.type === "userMessage") {
        const replies = parseCodexAsyncQuestionReplies(item.content);
        if (replies?.every((reply) => asyncQuestionIds.has(reply.questionItemId))) {
          upsertAsyncQuestionReply(buffer, itemId, formatCodexAsyncQuestionReplies(replies));
          return;
        }
        const messageId = `${messagePrefix}:user:${encodeURIComponent(itemId)}`;
        const parts = convertUserInputBlocks(sessionId, extractUserInputs(item.content), messageId);
        if (parts.length === 0) return;
        if (appendAssistant(false)) buffer = createBuffer(`assistant-after:${encodeURIComponent(itemId)}`);
        const userCreatedAt = createdAt + messageIndex++ / (items.length + 1);
        messages.push({
          id: messageId,
          sessionId,
          role: "user",
          time: { created: userCreatedAt, completed: userCreatedAt },
          parts,
        });
        return;
      }
      applyHistoricalItem(buffer, { ...item, id: itemId }, completedAt, turn.status);
    });

    appendAssistant(true);
  });

  return messages;
}

function applyHistoricalItem(
  buffer: MessageBuffer,
  item: CodexThreadItem & { id: string },
  completedAt: number,
  turnStatus: string | undefined,
): void {
  const itemId = item.id;
  const turnInProgress = turnStatus === "inProgress";
  switch (item.type) {
    case "agentMessage": {
      if (item.text || turnInProgress || Array.isArray(item.questions)) {
        upsertAgentMessage(buffer, itemId, item.text ?? "", {
          memoryCitation: item.memoryCitation,
          delivery: item.delivery,
          questions: item.questions,
          completed: !turnInProgress,
          phase: item.phase === "commentary" ? "commentary"
            : item.phase === "partial_answer" ? "partial"
            : item.phase === "final_answer" ? "final" : undefined,
        });
      }
      return;
    }
    case "reasoning": {
      const text = normalizeCodexReasoningText(item.summary, item.content);
      if (text) {
        upsertPart(buffer.parts, {
          id: codexItemPartId(buffer, itemId),
          messageId: buffer.messageId,
          sessionId: buffer.sessionId,
          type: "reasoning",
          summaryFormat: "heading-prefixed",
          text,
          // Native history does not expose reliable per-item elapsed time.
          completed: ["completed", "failed", "interrupted"].includes(turnStatus ?? ""),
        });
      }
      return;
    }
    case "plan": {
      replacePlanText(buffer, formatPlanMarkdown(item.text ?? ""), itemId);
      return;
    }
    case "contextCompaction": {
      createSystemNotice(buffer, "compact", "notice:context_compressed").id = codexItemPartId(buffer, itemId);
      return;
    }
    case "enteredReviewMode": {
      createSystemNotice(buffer, "info", item.review ? `Entered review mode: ${item.review}` : "Entered review mode").id = codexItemPartId(buffer, itemId);
      return;
    }
    case "exitedReviewMode": {
      createSystemNotice(buffer, "info", item.review ? `Exited review mode: ${item.review}` : "Exited review mode").id = codexItemPartId(buffer, itemId);
      return;
    }
    case "hookPrompt": {
      createSystemNotice(buffer, "info", "Hook prompt emitted").id = codexItemPartId(buffer, itemId);
      return;
    }
    default:
      break;
  }

  const params = itemToParams(item);
  const callId = itemId;
  const { toolPart } = createToolPart(buffer, callId, item.type === "functionCallOutput" ? item.name ?? item.type : item.type ?? "unknown", params);
  applyCodexToolDisplay(toolPart, { ...item }, buffer.workingDirectory);
  const startTime = item.durationMs != null ? completedAt - item.durationMs : buffer.startTime;
  const richOutput = extractCodexToolOutput(item, toolPart);
  const output = richOutput.output ?? itemToOutput(item);
  const isRunning = item.status === "inProgress"
    || (turnInProgress && item.status == null && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type ?? ""));
  const terminalError = !isRunning ? undefined
    : turnStatus === "interrupted" ? "Turn interrupted"
    : turnStatus === "failed" ? "Turn failed"
    : turnStatus === "completed" ? "Tool did not finish before the turn ended"
    : undefined;
  const error = normalizeItemError(item) ?? terminalError;
  toolPart.state = {
    status: "running",
    input: {
      ...asRecord(toolPart.state.input),
      ...(toolPart.normalizedTool === "shell" && output ? { _output: stringifyOutput(output) } : {}),
    },
    time: { start: startTime },
  };

  if (toolPart.diff == null) {
    const diff = extractDiffFromParams(params);
    if (diff) toolPart.diff = diff;
  }

  if (isRunning && !error) return;

  completeToolPart(
    toolPart,
    output,
    error,
    buildToolMetadata(toolPart.normalizedTool, params, output),
  );

  applyHistoricalToolTiming(toolPart, startTime, completedAt);

  createStepFinish(buffer, itemId);
  for (const attachment of richOutput.attachments) upsertPart(buffer.parts, attachment);
}

function convertUserInputBlocks(
  sessionId: string,
  blocks: CodexUserInput[],
  messageId: string,
): TextPart[] {
  const parts: TextPart[] = [];
  let index = 0;

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) {
          parts.push({
            id: `${messageId}_p${index++}`,
            messageId,
            sessionId,
            type: "text",
            text: block.text,
          });
        }
        break;
      case "image":
        parts.push({
          id: `${messageId}_p${index++}`,
          messageId,
          sessionId,
          type: "text",
          text: summarizeImageBlock(block.url),
        });
        break;
      case "localImage":
        parts.push({
          id: `${messageId}_p${index++}`,
          messageId,
          sessionId,
          type: "text",
          text: "[Image]",
        });
        break;
      case "skill":
        parts.push({
          id: `${messageId}_p${index++}`,
          messageId,
          sessionId,
          type: "text",
          text: `[Skill: ${block.name ?? "skill"}]`,
        });
        break;
      case "mention":
        parts.push({
          id: `${messageId}_p${index++}`,
          messageId,
          sessionId,
          type: "text",
          text: `[Mention: ${block.name ?? "mention"}]`,
        });
        break;
      default:
        break;
    }
  }

  parts.forEach((part, index) => { part.order = index; });
  return parts;
}

function buildPermissionOptions(
  method: string,
  availableDecisions: unknown,
): PermissionOption[] {
  if (method === "item/commandExecution/requestApproval") {
    const decisions = Array.isArray(availableDecisions)
      ? availableDecisions
        .map((decision) => {
          if (typeof decision === "string") return decision;
          if (decision && typeof decision === "object") return Object.keys(decision as Record<string, unknown>)[0] ?? "";
          return "";
        })
        .filter(Boolean)
      : [];

    const options: PermissionOption[] = [];
    if (decisions.length === 0 || decisions.includes("accept")) {
      options.push({ id: "allow_once", label: "Allow", type: "allow_once" });
    }
    if (decisions.length === 0 || decisions.includes("acceptForSession")) {
      options.push({ id: "allow_always", label: "Always Allow", type: "allow_always" });
    }
    options.push({ id: "reject_once", label: "Deny", type: "reject_once" });
    return options;
  }

  return [
    { id: "allow_once", label: "Allow", type: "allow_once" },
    { id: "allow_always", label: "Always Allow", type: "allow_always" },
    { id: "reject_once", label: "Deny", type: "reject_once" },
  ];
}

function normalizeToolInput(
  itemType: string,
  normalizedTool: NormalizedToolName,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const input = { ...params };

  if (normalizedTool === "shell") {
    if (typeof input.command !== "string") {
      input.command = typeof params.cmd === "string" ? params.cmd : "";
    }
    return input;
  }

  if (normalizedTool === "edit" || normalizedTool === "write" || normalizedTool === "read") {
    const filePath = extractFilePath(params);
    if (filePath) {
      input.filePath = filePath;
      input.path = filePath;
    }
    return input;
  }

  if (normalizedTool === "web_fetch") {
    const query = typeof params.query === "string" ? params.query : undefined;
    if (typeof input.url !== "string" && query) {
      input.url = `search:${query}`;
    }
    return input;
  }

  if (normalizedTool === "task") {
    const description = typeof params.description === "string"
      ? params.description
      : typeof params.title === "string"
        ? params.title
        : typeof params.tool === "string"
          ? params.tool
          : "Delegating task";
    return {
      ...input,
      description,
      prompt: typeof params.prompt === "string" ? params.prompt : undefined,
    };
  }

  if (itemType === "mcpToolCall") {
    const server = typeof params.server === "string" ? params.server : undefined;
    const tool = typeof params.tool === "string" ? params.tool : undefined;
    return {
      ...input,
      description: server && tool ? `${server}/${tool}` : tool ?? server ?? "MCP tool",
    };
  }

  return input;
}

function extractFilePath(params: Record<string, unknown>): string | undefined {
  if (typeof params.filePath === "string" && params.filePath) return params.filePath;
  if (typeof params.path === "string" && params.path) return params.path;
  if (typeof params.file_path === "string" && params.file_path) return params.file_path;
  if (typeof params.savedPath === "string" && params.savedPath) return params.savedPath;

  const changes = Array.isArray(params.changes) ? params.changes : [];
  for (const change of changes) {
    const record = asRecord(change);
    if (typeof record.path === "string" && record.path) return record.path;
  }

  return undefined;
}

function extractDiffFromParams(params: Record<string, unknown>): string | undefined {
  if (typeof params.diff === "string" && params.diff) return params.diff;

  const changes = Array.isArray(params.changes) ? params.changes : [];
  const diffs = changes
    .map((change) => {
      const record = asRecord(change);
      if (typeof record.diff === "string" && record.diff) return record.diff;
      if (typeof record.patch === "string" && record.patch) return record.patch;
      return "";
    })
    .filter(Boolean);

  return diffs.length > 0 ? diffs.join("\n") : undefined;
}

function itemToParams(item: CodexThreadItem): Record<string, unknown> {
  switch (item.type) {
    case "commandExecution":
      return {
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions,
        parsedCmd: item.parsedCmd,
      };
    case "fileChange":
      return {
        changes: item.changes,
      };
    case "mcpToolCall":
      return {
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
      };
    case "dynamicToolCall":
      return {
        tool: item.tool,
        arguments: item.arguments,
      };
    case "collabAgentToolCall":
      return {
        tool: item.tool,
        prompt: item.prompt,
        description: item.tool ? `Delegating via ${item.tool}` : "Delegating task",
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        receiverThreadIds: item.receiverThreadIds,
      };
    case "webSearch":
      return {
        query: item.query,
        action: item.action,
      };
    case "imageView":
      return {
        path: item.path,
      };
    case "imageGeneration":
      return {
        description: item.revisedPrompt ?? "Generating image",
        savedPath: item.savedPath,
      };
    default:
      return {};
  }
}

function itemToOutput(item: CodexThreadItem): unknown {
  switch (item.type) {
    case "commandExecution":
      return item.aggregatedOutput ?? "";
    case "fileChange":
      return Array.isArray(item.changes)
        ? item.changes.map((change) => asRecord(change).path).filter(Boolean).join("\n")
        : "";
    case "mcpToolCall":
      return item.result ?? "";
    case "dynamicToolCall":
      return item.contentItems ?? item.result ?? "";
    case "collabAgentToolCall":
      return {
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates,
      };
    case "webSearch":
      return item.query ?? "";
    case "imageView":
      return item.path ?? "";
    case "imageGeneration":
      return item.savedPath ?? item.result ?? "";
    default:
      return "";
  }
}

function buildToolMetadata(
  normalizedTool: NormalizedToolName,
  params: Record<string, unknown>,
  output: unknown,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (normalizedTool === "edit" || normalizedTool === "write") {
    const diff = extractDiffFromParams(params);
    if (diff) metadata.diff = diff;
  }

  if (normalizedTool === "read") {
    const outputText = stringifyOutput(output);
    if (outputText) metadata.lines = outputText.split("\n").length;
  }

  if (normalizedTool === "task" && typeof params.prompt === "string") {
    metadata.prompt = params.prompt;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function formatPlanMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "## Plan\n\n";
  if (trimmed.startsWith("#")) return trimmed;
  return `## Plan\n\n${trimmed}`;
}

function normalizeHistoricalEffort(value: string): ReasoningEffort | undefined {
  switch (value) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return undefined;
  }
}

function normalizeItemError(item: CodexThreadItem): string | undefined {
  const explicit = normalizeError(item.error);
  if (explicit) return explicit;

  if (typeof item.exitCode === "number" && item.exitCode !== 0) {
    return `Exit code: ${item.exitCode}`;
  }

  if (item.status === "failed" || item.status === "declined") {
    return typeof item.result === "string" && item.result ? item.result : "Tool failed";
  }

  return undefined;
}

function normalizeError(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const details = typeof record.additionalDetails === "string" ? record.additionalDetails : undefined;
    if (message && details) return `${message}\n\n${details}`;
    if (message) return message;
  }
  return undefined;
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function getRunningToolOutput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const output = (input as Record<string, unknown>)._output;
  return typeof output === "string" ? output : "";
}

function applyHistoricalToolTiming(toolPart: ToolPart, startTime: number, completedAt: number): void {
  if (toolPart.state.status === "completed") {
    toolPart.state = {
      ...toolPart.state,
      time: {
        start: startTime,
        end: completedAt,
        duration: Math.max(0, completedAt - startTime),
      },
    };
    return;
  }

  if (toolPart.state.status === "error") {
    toolPart.state = {
      ...toolPart.state,
      time: {
        start: startTime,
        end: completedAt,
        duration: Math.max(0, completedAt - startTime),
      },
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractUserInputs(value: unknown): CodexUserInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((input): input is CodexUserInput => Boolean(input) && typeof input === "object");
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toMillis(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function summarizeImageBlock(url?: string): string {
  if (typeof url === "string") {
    const match = /^data:([^;,]+)[;,]/i.exec(url);
    if (match?.[1]) {
      return `[Image: ${match[1]}]`;
    }
  }

  return "[Image]";
}
