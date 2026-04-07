// ============================================================================
// Codex Protocol → Unified Type Converters
//
// Maps Codex app-server JSON-RPC events to CodeMux unified types.
// ============================================================================

import { timeId } from "../../utils/id-gen";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import type {
  UnifiedMessage,
  UnifiedPart,
  UnifiedPermission,
  UnifiedQuestion,
  PermissionOption,
  TextPart,
  ReasoningPart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  NormalizedToolName,
} from "../../../../src/types/unified";
import type { MessageBuffer } from "../engine-adapter";

// ============================================================================
// Message Buffer Helpers
// ============================================================================

/**
 * Insert or update a part in a parts array by ID.
 */
export function upsertPart(parts: UnifiedPart[], part: UnifiedPart): void {
  const idx = parts.findIndex((p) => p.id === part.id);
  if (idx >= 0) {
    parts[idx] = part;
  } else {
    parts.push(part);
  }
}

/**
 * Append text delta to the message buffer, emitting TextPart updates.
 */
export function appendTextDelta(
  buffer: MessageBuffer,
  delta: string,
): TextPart {
  buffer.textAccumulator += delta;

  // Trim leading whitespace (once)
  if (!buffer.leadingTrimmed) {
    const trimmed = buffer.textAccumulator.trimStart();
    if (!trimmed) {
      // All whitespace so far — return a placeholder part but don't mark trimmed
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

/**
 * Append reasoning delta to the message buffer.
 */
export function appendReasoningDelta(
  buffer: MessageBuffer,
  delta: string,
): ReasoningPart {
  buffer.reasoningAccumulator += delta;
  if (!buffer.reasoningPartId) buffer.reasoningPartId = timeId("part");

  const reasoningPart: ReasoningPart = {
    id: buffer.reasoningPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "reasoning",
    text: buffer.reasoningAccumulator,
  };
  upsertPart(buffer.parts, reasoningPart);
  return reasoningPart;
}

// ============================================================================
// Tool Helpers
// ============================================================================

/**
 * Build a human-readable title for a Codex tool call.
 */
export function buildToolTitle(
  itemType: string,
  normalizedTool: NormalizedToolName,
  params: unknown,
): string {
  const input = params && typeof params === "object" ? (params as Record<string, unknown>) : {};

  switch (normalizedTool) {
    case "shell": {
      const cmd = (input.command as string) ?? (input.cmd as string) ?? "";
      const short = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      return short || "Running command";
    }
    case "read": {
      const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
      return filePath ? `Reading ${filePath}` : "Reading file";
    }
    case "edit": {
      const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
      return filePath ? `Editing ${filePath}` : "Editing file";
    }
    default:
      return itemType;
  }
}

/**
 * Create a ToolPart for a Codex tool execution.
 */
export function createToolPart(
  buffer: MessageBuffer,
  callId: string,
  itemType: string,
  params: unknown,
): { stepStart: StepStartPart; toolPart: ToolPart } {
  const normalizedTool = normalizeToolName("codex", itemType);
  const kind = inferToolKind(undefined, normalizedTool);
  const title = buildToolTitle(itemType, normalizedTool, params);

  const stepStartId = timeId("part");
  const toolPartId = timeId("part");

  const stepStart: StepStartPart = {
    id: stepStartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "step-start",
  };

  const toolPart: ToolPart = {
    id: toolPartId,
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "tool",
    callId,
    normalizedTool,
    originalTool: itemType,
    title,
    kind,
    state: {
      status: "running",
      input: (params ?? {}) as Record<string, unknown>,
      time: { start: Date.now() },
    },
  };

  buffer.parts.push(stepStart);
  buffer.parts.push(toolPart);

  return { stepStart, toolPart };
}

/**
 * Mark a tool part as completed.
 * Populates `metadata` for frontend rendering:
 * - BashTool reads `metadata.output`
 * - EditTool reads `metadata.diff`
 */
export function completeToolPart(
  toolPart: ToolPart,
  output: unknown,
  error?: string,
): void {
  const startTime = toolPart.state.status === "running" ? toolPart.state.time.start : Date.now();
  const endTime = Date.now();
  const input = toolPart.state.status !== "pending" ? toolPart.state.input : {};

  // Build metadata for frontend tool components
  const outputStr = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
  const metadata: Record<string, unknown> = {};

  if (error) {
    metadata.error = true;
    metadata.message = error;
  }

  // Shell tools: BashTool reads metadata.output / metadata.stdout
  if (toolPart.normalizedTool === "shell") {
    // Include any accumulated streaming output from _output
    const accumulatedOutput = (input as Record<string, unknown>)?._output;
    metadata.output = outputStr || accumulatedOutput || "";
    metadata.stdout = metadata.output;
  }

  // Edit tools: EditTool reads metadata.diff
  if (toolPart.normalizedTool === "edit" || toolPart.normalizedTool === "write") {
    if (toolPart.diff) {
      metadata.diff = toolPart.diff;
    }
  }

  if (error) {
    toolPart.state = {
      status: "error",
      input,
      error,
      time: { start: startTime, end: endTime, duration: endTime - startTime },
    };
  } else {
    toolPart.state = {
      status: "completed",
      input,
      output: output ?? "",
      time: { start: startTime, end: endTime, duration: endTime - startTime },
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}

/**
 * Create a StepFinishPart.
 */
export function createStepFinish(buffer: MessageBuffer): StepFinishPart {
  const part: StepFinishPart = {
    id: timeId("part"),
    messageId: buffer.messageId,
    sessionId: buffer.sessionId,
    type: "step-finish",
  };
  buffer.parts.push(part);
  return part;
}

// ============================================================================
// Permission / Question Converters
// ============================================================================

/**
 * Convert a Codex ApprovalRequest (or FileApprovalRequest, ExecApprovalRequest, etc.)
 * to a UnifiedPermission.
 */
export function convertApprovalToPermission(
  sessionId: string,
  requestId: number | string,
  method: string,
  params: unknown,
): UnifiedPermission {
  const data = (params ?? {}) as Record<string, unknown>;

  // Determine kind and title based on request type
  let kind: "read" | "edit" | "other" = "other";
  let title = "Codex needs approval";
  let diff: string | undefined;
  let toolCallId: string | undefined;

  if (method === "FileApprovalRequest" || method === "codex/fileApprovalRequest") {
    kind = "edit";
    const path = (data.path as string) ?? (data.file as string) ?? "";
    title = path ? `Edit file: ${path}` : "Edit file";
    diff = data.diff as string | undefined;
    toolCallId = data.toolCallId as string | undefined;
  } else if (method === "ExecApprovalRequest" || method === "codex/execApprovalRequest") {
    kind = "other";
    const cmd = (data.command as string) ?? "";
    title = cmd ? `Run command: ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}` : "Run command";
    toolCallId = data.toolCallId as string | undefined;
  } else if (method === "McpApprovalRequest" || method === "codex/mcpApprovalRequest") {
    kind = "other";
    const tool = (data.tool as string) ?? (data.name as string) ?? "MCP tool";
    title = `Use MCP tool: ${tool}`;
    toolCallId = data.toolCallId as string | undefined;
  } else {
    // Generic ApprovalRequest
    title = (data.message as string) ?? (data.description as string) ?? "Codex needs approval";
    const cmd = data.command as string | undefined;
    if (cmd) {
      kind = "other";
      title = `Run command: ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`;
    }
    toolCallId = data.toolCallId as string | undefined;
  }

  const options: PermissionOption[] = [
    { id: "allow_once", label: "Allow", type: "allow_once" },
    { id: "allow_always", label: "Always Allow", type: "allow_always" },
    { id: "reject_once", label: "Deny", type: "reject_once" },
  ];

  return {
    id: String(requestId),
    sessionId,
    engineType: "codex",
    toolCallId,
    title,
    kind,
    diff,
    rawInput: params,
    options,
  };
}

/**
 * Convert a Codex AskForConfirmation to a UnifiedQuestion.
 */
export function convertConfirmationToQuestion(
  sessionId: string,
  requestId: number | string,
  params: unknown,
): UnifiedQuestion {
  const data = (params ?? {}) as Record<string, unknown>;

  const question = (data.message as string) ?? (data.question as string) ?? "Codex needs your input";
  const header = "Confirm";

  return {
    id: String(requestId),
    sessionId,
    engineType: "codex",
    questions: [{
      question,
      header,
      options: [
        { label: "Yes", description: "Confirm" },
        { label: "No", description: "Deny" },
      ],
      multiple: false,
      custom: true,
    }],
    metadata: { requestId, rawParams: params },
  };
}

// ============================================================================
// Message Finalization
// ============================================================================

/**
 * Build a finalized UnifiedMessage from a MessageBuffer.
 */
export function finalizeBufferToMessage(buffer: MessageBuffer): UnifiedMessage {
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
  };
}

/**
 * Create a user message.
 */
export function createUserMessage(
  sessionId: string,
  text: string,
): UnifiedMessage {
  const messageId = timeId("msg");
  const partId = timeId("part");

  const textPart: TextPart = {
    id: partId,
    messageId,
    sessionId,
    type: "text",
    text,
  };

  return {
    id: messageId,
    sessionId,
    role: "user",
    time: { created: Date.now(), completed: Date.now() },
    parts: [textPart],
  };
}

// ============================================================================
// Historical Thread Item Converters
// ============================================================================

/**
 * A Codex thread item from codex/threadRead.
 */
interface CodexThreadItem {
  type?: string;
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  item_type?: string;
  command?: string;
  output?: string;
  path?: string;
  diff?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  timestamp?: number;
}

/**
 * Convert an array of Codex thread items into UnifiedMessages.
 * Groups consecutive assistant-role items into single messages.
 */
export function convertThreadItemsToMessages(
  sessionId: string,
  items: CodexThreadItem[],
): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  let currentAssistantParts: UnifiedPart[] = [];
  let currentAssistantTime: number | undefined;

  const flushAssistant = () => {
    if (currentAssistantParts.length === 0) return;
    const msgId = timeId("msg");
    // Update messageId on all parts
    for (const p of currentAssistantParts) {
      p.messageId = msgId;
    }
    messages.push({
      id: msgId,
      sessionId,
      role: "assistant",
      time: {
        created: currentAssistantTime ?? Date.now(),
        completed: currentAssistantTime ?? Date.now(),
      },
      parts: currentAssistantParts,
    });
    currentAssistantParts = [];
    currentAssistantTime = undefined;
  };

  for (const item of items) {
    const role = item.role ?? (item.item_type ? "assistant" : "user");
    const timestamp = item.timestamp ?? Date.now();

    if (role === "user") {
      // Flush any pending assistant message
      flushAssistant();

      // Extract text from content
      let text = "";
      if (typeof item.content === "string") {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .filter((c) => c.type === "input_text" || c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
      }

      if (text) {
        const msgId = timeId("msg");
        messages.push({
          id: msgId,
          sessionId,
          role: "user",
          time: { created: timestamp, completed: timestamp },
          parts: [{
            id: timeId("part"),
            messageId: msgId,
            sessionId,
            type: "text",
            text,
          } as TextPart],
        });
      }
    } else {
      // Assistant-role item
      if (!currentAssistantTime) currentAssistantTime = timestamp;
      const placeholderMsgId = ""; // Will be set in flushAssistant

      // Text content
      if (item.type === "message" || (!item.item_type && typeof item.content === "string")) {
        const text = typeof item.content === "string" ? item.content : "";
        if (text) {
          currentAssistantParts.push({
            id: timeId("part"),
            messageId: placeholderMsgId,
            sessionId,
            type: "text",
            text,
          } as TextPart);
        }
      }

      // Tool-related items
      if (item.item_type) {
        const normalizedTool = normalizeToolName("codex", item.item_type);
        const kind = inferToolKind(undefined, normalizedTool);
        const input: Record<string, unknown> = {};
        if (item.command) input.command = item.command;
        if (item.path) input.path = item.path;
        if (item.arguments) Object.assign(input, item.arguments);

        const title = buildToolTitle(item.item_type, normalizedTool, input);

        const stepStartPart: StepStartPart = {
          id: timeId("part"),
          messageId: placeholderMsgId,
          sessionId,
          type: "step-start",
        };

        const toolPart: ToolPart = {
          id: timeId("part"),
          messageId: placeholderMsgId,
          sessionId,
          type: "tool",
          callId: timeId("call"),
          normalizedTool,
          originalTool: item.item_type,
          title,
          kind,
          state: {
            status: "completed",
            input,
            output: item.output ?? item.result ?? "",
            time: { start: timestamp, end: timestamp, duration: 0 },
          },
        };

        if (item.diff) {
          toolPart.diff = item.diff;
        }

        const stepFinishPart: StepFinishPart = {
          id: timeId("part"),
          messageId: placeholderMsgId,
          sessionId,
          type: "step-finish",
        };

        currentAssistantParts.push(stepStartPart, toolPart, stepFinishPart);
      }
    }
  }

  // Flush remaining assistant parts
  flushAssistant();

  return messages;
}
