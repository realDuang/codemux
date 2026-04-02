import { timeId } from "../../utils/id-gen";
import type {
  SessionEvent,
  SessionMetadata,
  ModelInfo,
} from "@github/copilot-sdk";
import { inferToolKind, normalizeToolName } from "../../../../src/types/tool-mapping";
import type {
  EngineType,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  UnifiedModelInfo,
  ReasoningEffort,
  NormalizedToolName,
  ToolPart,
  TextPart,
  ReasoningPart,
} from "../../../../src/types/unified";
import { homedir } from "os";

/**
 * Convert an array of SDK session events into UnifiedMessage[].
 * Used when loading historical messages from a resumed session.
 */
export function convertEventsToMessages(
  sessionId: string,
  events: SessionEvent[],
): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  let currentAssistantMsg: UnifiedMessage | null = null;
  let textAccum = "";
  let textPartId: string | null = null;
  let reasoningAccum = "";
  let reasoningPartId: string | null = null;
  // Track the current event's real timestamp for accurate history replay
  let currentEventTs = 0;

  const flushText = () => {
    if (textAccum && textPartId && currentAssistantMsg) {
      const existingIdx = currentAssistantMsg.parts.findIndex((p) => p.id === textPartId);
      const textPart: TextPart = {
        id: textPartId!,
        messageId: currentAssistantMsg.id,
        sessionId,
        type: "text",
        text: textAccum,
      };
      if (existingIdx >= 0) {
        currentAssistantMsg.parts[existingIdx] = textPart;
      } else {
        currentAssistantMsg.parts.push(textPart);
      }
    }
    textAccum = "";
    textPartId = null;
  };

  const flushReasoning = () => {
    if (reasoningAccum && reasoningPartId && currentAssistantMsg) {
      const existingIdx = currentAssistantMsg.parts.findIndex((p) => p.id === reasoningPartId);
      const reasoningPart: ReasoningPart = {
        id: reasoningPartId!,
        messageId: currentAssistantMsg.id,
        sessionId,
        type: "reasoning",
        text: reasoningAccum,
      };
      if (existingIdx >= 0) {
        currentAssistantMsg.parts[existingIdx] = reasoningPart;
      } else {
        currentAssistantMsg.parts.push(reasoningPart);
      }
    }
    reasoningAccum = "";
    reasoningPartId = null;
  };

  const ensureAssistantMessage = (): UnifiedMessage => {
    if (!currentAssistantMsg) {
      currentAssistantMsg = {
        id: timeId("msg"),
        sessionId,
        role: "assistant",
        time: { created: currentEventTs },
        parts: [],
      };
    }
    return currentAssistantMsg;
  };

  const finalizeAssistant = () => {
    if (currentAssistantMsg) {
      flushText();
      flushReasoning();
      currentAssistantMsg.time.completed = currentEventTs;
      messages.push(currentAssistantMsg);
      currentAssistantMsg = null;
    }
  };

  // Track tool calls for history replay
  const replayToolParts = new Map<string, ToolPart>();

  for (const event of events) {
    // Parse the real event timestamp for accurate history replay
    currentEventTs = new Date(event.timestamp).getTime() || Date.now();

    switch (event.type) {
      case "user.message": {
        // Finalize any pending assistant message
        finalizeAssistant();

        const userData = event.data as { content?: string };
        const userMsg = createUserMessage(
          sessionId,
          userData.content ?? "",
          currentEventTs,
        );
        messages.push(userMsg);
        break;
      }

      case "assistant.message_delta": {
        ensureAssistantMessage();
        const delta = event.data as { deltaContent: string };
        textAccum += delta.deltaContent;
        if (!textPartId) textPartId = timeId("part");
        break;
      }

      case "assistant.reasoning_delta": {
        ensureAssistantMessage();
        const rDelta = event.data as { deltaContent: string };
        reasoningAccum += rDelta.deltaContent;
        if (!reasoningPartId) reasoningPartId = timeId("part");
        break;
      }

      case "assistant.message": {
        const aData = event.data as { content?: string };
        if (aData.content && !textAccum) {
          ensureAssistantMessage();
          textAccum = aData.content;
          if (!textPartId) textPartId = timeId("part");
        }
        break;
      }

      case "tool.execution_start": {
        const tData = event.data as {
          toolCallId: string;
          toolName: string;
          arguments?: unknown;
        };

        // task_complete — extract summary as text, skip tool part
        if (tData.toolName === "task_complete") {
          const args = (tData.arguments ?? {}) as Record<string, unknown>;
          const summary = typeof args.summary === "string" ? args.summary : "";
          if (summary) {
            ensureAssistantMessage();
            textAccum += summary;
            if (!textPartId) textPartId = timeId("part");
          }
          break;
        }

        const msg = ensureAssistantMessage();
        flushText();
        const normalizedTool = normalizeToolName("copilot", tData.toolName);
        const kind = inferToolKind(undefined, normalizedTool);
        const title = buildToolTitle(tData.toolName, normalizedTool, tData.arguments);
        const partId = timeId("part");

        const toolPart: ToolPart = {
          id: partId,
          messageId: msg.id,
          sessionId,
          type: "tool",
          callId: tData.toolCallId,
          normalizedTool,
          originalTool: tData.toolName,
          title,
          kind,
          state: {
            status: "running",
            input: (tData.arguments ?? {}) as any,
            time: { start: currentEventTs },
          },
        };

        replayToolParts.set(tData.toolCallId, toolPart);
        msg.parts.push(toolPart);
        break;
      }

      case "tool.execution_complete": {
        const cData = event.data as {
          toolCallId: string;
          success: boolean;
          result?: { content?: string; detailedContent?: string };
          error?: string;
        };

        const existingTool = replayToolParts.get(cData.toolCallId);
        if (existingTool) {
          const endTs = currentEventTs;
          const startTime =
            existingTool.state.status === "running"
              ? existingTool.state.time.start
              : endTs;

          if (cData.success) {
            existingTool.state = {
              status: "completed",
              input: existingTool.state.status !== "pending" ? existingTool.state.input : {},
              output: cData.result?.content ?? "",
              time: {
                start: startTime,
                end: endTs,
                duration: endTs - startTime,
              },
            };
          } else {
            existingTool.state = {
              status: "error",
              input: existingTool.state.status !== "pending" ? existingTool.state.input : {},
              error: cData.error ?? "Failed",
              time: {
                start: startTime,
                end: endTs,
                duration: endTs - startTime,
              },
            };
          }

          if (cData.result?.detailedContent) {
            existingTool.diff = cData.result.detailedContent;
          }

          replayToolParts.delete(cData.toolCallId);
        }
        break;
      }

      case "assistant.usage": {
        const msg = ensureAssistantMessage();
        {
          const uData = event.data as {
            model?: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            cost?: number;
          };
          const cacheRead = uData.cacheReadTokens ?? 0;
          const cacheWrite = uData.cacheWriteTokens ?? 0;
          msg.tokens = {
            input: uData.inputTokens ?? 0,
            output: uData.outputTokens ?? 0,
            cache: cacheRead || cacheWrite ? { read: cacheRead, write: cacheWrite } : undefined,
          };
          // Copilot's `cost` is a premium-request count (not USD)
          if (uData.cost != null) {
            msg.cost = uData.cost;
            msg.costUnit = "premium_requests";
          }
          if (uData.model) msg.modelId = uData.model;
        }
        break;
      }

      case "session.idle":
        finalizeAssistant();
        break;

      case "session.title_changed":
        // Title changes are handled by EngineManager via live event handler
        break;

      default:
        // Skip events that don't contribute to message history
        break;
    }
  }

  // Finalize any remaining assistant message
  finalizeAssistant();

  return messages;
}

export function createUserMessage(
  sessionId: string,
  text: string,
  timestamp: number,
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
    time: {
      created: timestamp,
      completed: timestamp,
    },
    parts: [textPart],
  };
}

/**
 * Build a human-readable title for a tool call.
 */
export function buildToolTitle(
  originalTool: string,
  normalizedTool: NormalizedToolName,
  args: unknown,
): string {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  switch (normalizedTool) {
    case "shell": {
      const cmd = (input.command as string) ?? "";
      const short = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      return short || "Running command";
    }
    case "read": {
      const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
      return filePath ? `Reading ${filePath}` : "Reading file";
    }
    case "write": {
      const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
      return filePath ? `Writing ${filePath}` : "Writing file";
    }
    case "edit": {
      const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
      return filePath ? `Editing ${filePath}` : "Editing file";
    }
    case "grep": {
      const pattern = (input.pattern as string) ?? (input.query as string) ?? "";
      return pattern ? `Searching for "${pattern}"` : "Searching";
    }
    case "glob": {
      const pattern = (input.pattern as string) ?? "";
      return pattern ? `Finding files matching ${pattern}` : "Finding files";
    }
    case "web_fetch": {
      const url = (input.url as string) ?? "";
      return url ? `Fetching ${url}` : "Fetching URL";
    }
    case "task":
      return (input.description as string) ?? "Running task";
    case "todo":
      return "Updating todos";
    case "list":
      return "Listing files";
    default:
      return originalTool;
  }
}

/**
 * Normalize todo tool input: Copilot sends markdown string
 * ("- [ ] task\n- [x] done"), convert to unified array format.
 */
export function normalizeTodoInput(args: unknown): Record<string, unknown> {
  const input = (args ?? {}) as Record<string, unknown>;
  const raw = input.todos;
  if (typeof raw === "string" && /[-*]\s*\[[ xX]\]/.test(raw)) {
    const todos: Array<{ content: string; status: string }> = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^[-*]\s*\[([ xX])\]\s+(.+)/);
      if (m) {
        todos.push({
          content: m[2].trim(),
          status: m[1] === " " ? "pending" : "completed",
        });
      }
    }
    if (todos.length > 0) return { ...input, todos };
  }
  return input;
}

/** Map Copilot's todo status names to the unified format. */
export function normalizeTodoStatus(status: string): "pending" | "in_progress" | "completed" {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "done":
    case "completed":
      return "completed";
    default:
      return "pending";
  }
}

/**
 * Insert or update a part in the buffer's parts array.
 */
export function upsertPart(parts: UnifiedPart[], part: UnifiedPart): void {
  const idx = parts.findIndex((p) => p.id === part.id);
  if (idx >= 0) {
    parts[idx] = part;
  } else {
    parts.push(part);
  }
}

export function sdkModelToUnified(engineType: EngineType, model: ModelInfo): UnifiedModelInfo {
  const reasoningEffortMap: Record<string, ReasoningEffort> = { xhigh: "max", low: "low", medium: "medium", high: "high" };
  const supportedLevels = model.supportedReasoningEfforts?.map(
    (l) => reasoningEffortMap[l] ?? (l as ReasoningEffort),
  );
  const defaultLevel = model.defaultReasoningEffort
    ? (reasoningEffortMap[model.defaultReasoningEffort] ?? (model.defaultReasoningEffort as unknown as ReasoningEffort))
    : undefined;

  return {
    modelId: model.id,
    name: model.name,
    engineType,
    capabilities: {
      attachment: model.capabilities?.supports?.vision ?? false,
      reasoning: model.capabilities?.supports?.reasoningEffort != null,
      supportedReasoningEfforts: supportedLevels,
      defaultReasoningEffort: defaultLevel,
    },
    meta: {
      maxContextTokens: model.capabilities?.limits?.max_context_window_tokens,
      policy: (model as unknown as Record<string, unknown>).policy,
      billing: (model as unknown as Record<string, unknown>).billing,
    },
  };
}

export function metadataToSession(engineType: EngineType, meta: SessionMetadata): UnifiedSession {
  const directory = meta.context?.cwd
    ? meta.context.cwd.replaceAll("\\", "/")
    : homedir().replaceAll("\\", "/");

  return {
    id: meta.sessionId,
    engineType,
    directory,
    title: meta.summary,
    time: {
      created: meta.startTime.getTime(),
      updated: meta.modifiedTime.getTime(),
    },
    engineMeta: {
      isRemote: meta.isRemote,
      repository: meta.context?.repository,
      branch: meta.context?.branch,
      gitRoot: meta.context?.gitRoot,
    },
  };
}
