/**
 * Claude Code adapter — pure conversion helpers.
 * Transforms Claude SDK types into the unified CodeMux message format.
 */

import type {
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { createTwoFilesPatch } from "diff";
import { timeId } from "../../utils/id-gen";
import { normalizeToolName, inferToolKind } from "../../../../src/types/tool-mapping";
import type {
  EngineType,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  TextPart,
  FilePart,
  ReasoningPart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
} from "../../../../src/types/unified";

/**
 * Convert snake_case tool input keys to camelCase so the frontend tool
 * renderers (which expect e.g. `filePath`, `oldString`) work with Claude's
 * tool input (`file_path`, `old_string`). Used for both live and history.
 */
export function normalizeToolInputKeys(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

/**
 * Build `{ diff }` metadata for a completed Edit tool call from its
 * (already camelCased) input, so the diff viewer can render it.
 */
export function buildEditDiffMetadata(
  normalizedTool: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (normalizedTool !== "edit" || !input) return undefined;

  const filePath = (input.filePath as string) ?? "";
  const oldStr = (input.oldString as string) ?? "";
  const newStr = (input.newString as string) ?? "";
  if (!oldStr && !newStr) return undefined;

  try {
    const diff = createTwoFilesPatch(filePath, filePath, oldStr, newStr, "", "", { context: 3 });
    return { diff };
  } catch {
    return undefined;
  }
}

// --- Claude Code transcript markers --------------------------------------
// The CLI stores slash-command invocations and their local output as user
// messages wrapped in XML-ish tags. They are not real user prompts.

const LOCAL_COMMAND_CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*<\/local-command-caveat>\s*$/;
const COMMAND_BLOCK_RE = /<command-(name|message|args)>([\s\S]*?)<\/command-\1>/g;
const LOCAL_COMMAND_STDOUT_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;
const INTERRUPTED_RE = /^\[Request interrupted by user[^\]]*\]$/;
const COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";

type UserTextClass =
  | { kind: "prompt"; text: string }
  | { kind: "command"; text: string }
  | { kind: "command-output"; text: string }
  | { kind: "interrupted" }
  | { kind: "skip" };

function classifyUserText(raw: string): UserTextClass {
  const text = raw.trim();
  if (!text) return { kind: "skip" };
  if (LOCAL_COMMAND_CAVEAT_RE.test(text)) return { kind: "skip" };
  if (INTERRUPTED_RE.test(text)) return { kind: "interrupted" };
  if (text.startsWith(COMPACT_SUMMARY_PREFIX)) return { kind: "skip" };

  // Only unwrap complete transcript records; prompts can quote these tags.
  const commandBlocks = [...text.matchAll(COMMAND_BLOCK_RE)];
  const name = commandBlocks.find((block) => block[1] === "name")?.[2].trim();
  if (name && commandBlocks.some((block) => block[1] === "message") && !text.replace(COMMAND_BLOCK_RE, "").trim()) {
    const args = commandBlocks.find((block) => block[1] === "args")?.[2].trim();
    const cmd = name.startsWith("/") ? name : `/${name}`;
    return { kind: "command", text: args ? `${cmd} ${args}` : cmd };
  }

  const outputBlocks = [...text.matchAll(LOCAL_COMMAND_STDOUT_RE)];
  if (outputBlocks.length > 0 && !text.replace(LOCAL_COMMAND_STDOUT_RE, "").trim()) {
    const outputs = outputBlocks.map((block) => block[2].trim()).filter(Boolean);
    return outputs.length > 0 ? { kind: "command-output", text: outputs.join("\n") } : { kind: "skip" };
  }

  return { kind: "prompt", text: raw };
}

export function sdkSessionToUnified(
  engineType: EngineType,
  sdkSession: SDKSessionInfo,
  directory?: string,
): UnifiedSession {
  return {
    id: `cc_${sdkSession.sessionId}`,
    engineType,
    directory:
      (sdkSession.cwd ?? directory ?? "").replaceAll("\\", "/"),
    title:
      sdkSession.customTitle ??
      sdkSession.summary ??
      sdkSession.firstPrompt?.slice(0, 100) ??
      "Untitled",
    time: {
      created: sdkSession.lastModified,
      updated: sdkSession.lastModified,
    },
    engineMeta: {
      ccSessionId: sdkSession.sessionId,
      gitBranch: sdkSession.gitBranch,
    },
  };
}

export function convertSdkMessages(
  sdkMessages: any[],
  sessionId: string,
  timestamps?: Map<string, number>,
): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];

  // getSessionMessages() includes an ISO `timestamp` on recent SDK versions;
  // the raw-.jsonl map is kept as the primary source for older ones.
  const tsOf = (msg: any): number => {
    if (!msg) return 0;
    const fromMap = msg.uuid ? timestamps?.get(msg.uuid) : undefined;
    if (fromMap) return fromMap;
    if (typeof msg.timestamp === "string") {
      const parsed = Date.parse(msg.timestamp);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  };

  // Build lookups from tool_use_id → timestamp and output content.
  // In the .jsonl, a tool_use block in an assistant message is followed by
  // a user message containing the tool_result. The time between the assistant
  // message and the tool_result user message is the tool execution duration.
  const toolResultTimestamps = new Map<string, number>();
  const toolResultOutputs = new Map<string, { output: string; isError: boolean }>();
  for (const msg of sdkMessages) {
    if (msg.type !== "user") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    const msgTs = tsOf(msg);
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        if (msgTs) toolResultTimestamps.set(block.tool_use_id, msgTs);
        // Extract tool output text
        let output = "";
        if (typeof block.content === "string") {
          output = block.content;
        } else if (Array.isArray(block.content)) {
          output = block.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        }
        toolResultOutputs.set(block.tool_use_id, {
          output,
          isError: !!block.is_error,
        });
      }
    }
  }

  // The last assistant message pushed, plus its API message id, so that the
  // per-content-block transcript entries of one API response are merged back
  // into a single message (matching what the live stream renders).
  let lastAssistant: { message: UnifiedMessage; apiId?: string } | null = null;

  const pushAssistantText = (msgId: string, created: number, completed: number, text: string) => {
    const message: UnifiedMessage = {
      id: msgId,
      sessionId,
      role: "assistant",
      time: { created: created || Date.now(), completed: completed || created || undefined },
      parts: [{ type: "text", text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart],
    };
    messages.push(message);
    lastAssistant = { message };
  };

  for (let index = 0; index < sdkMessages.length; index++) {
    const msg = sdkMessages[index];
    const msgTs = tsOf(msg);

    if (msg.type === "user") {
      const msgId = msg.uuid ?? timeId("msg");
      const parts: UnifiedPart[] = [];
      const content = msg.message?.content;
      const texts: string[] = typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text)
          : [];

      let commandOutput: string | null = null;
      for (const raw of texts) {
        const cls = classifyUserText(raw);
        if (cls.kind === "prompt" || cls.kind === "command") {
          parts.push({ type: "text", text: cls.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
        } else if (cls.kind === "command-output") {
          commandOutput = commandOutput ? `${commandOutput}\n${cls.text}` : cls.text;
        } else if (cls.kind === "interrupted") {
          const prev = lastAssistant as { message: UnifiedMessage } | null;
          if (prev && !prev.message.error) prev.message.error = "error:stopped_by_user";
        }
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "image" || block.source?.type !== "base64" || !block.source.data) continue;
          const mime = block.source.media_type || "image/png";
          parts.push({
            type: "file",
            id: timeId("pt"),
            messageId: msgId,
            sessionId,
            mime,
            filename: `image.${mime.split("/")[1] || "png"}`,
            url: `data:${mime};base64,${block.source.data}`,
          } as FilePart);
        }
      }

      if (parts.length > 0) {
        messages.push({
          id: msgId,
          sessionId,
          role: "user",
          time: { created: msgTs || Date.now() },
          parts,
        });
        lastAssistant = null;
      }
      if (commandOutput) {
        pushAssistantText(`${msgId}_out`, msgTs, msgTs, commandOutput);
      }
    } else if (msg.type === "assistant") {
      const content = msg.message?.content;
      const apiId: string | undefined = msg.message?.id;
      const prev = lastAssistant as { message: UnifiedMessage; apiId?: string } | null;
      const mergeInto = apiId && prev?.apiId === apiId ? prev.message : null;
      const msgId = mergeInto?.id ?? msg.uuid ?? timeId("msg");
      const parts: UnifiedPart[] = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            if (!block.text) continue;
            parts.push({ type: "text", text: block.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
          } else if (block.type === "thinking") {
            if (!block.thinking) continue;
            parts.push({
              type: "reasoning",
              text: block.thinking,
              id: timeId("pt"),
              messageId: msgId,
              sessionId,
            } as ReasoningPart);
          } else if (block.type === "tool_use") {
            const normalizedTool = normalizeToolName("claude", block.name ?? "");
            const input = block.input && typeof block.input === "object"
              ? normalizeToolInputKeys(block.input)
              : {};

            // Calculate tool duration from timestamps
            const toolStart = msgTs;
            const toolEnd = toolResultTimestamps.get(block.id) ?? 0;
            const toolDuration = (toolStart && toolEnd && toolEnd > toolStart)
              ? toolEnd - toolStart
              : 0;

            // Get tool output from the corresponding tool_result message
            const result = toolResultOutputs.get(block.id);
            const toolState = result?.isError
              ? {
                  status: "error" as const,
                  input,
                  error: result.output,
                  time: { start: toolStart, end: toolEnd || toolStart, duration: toolDuration },
                }
              : {
                  status: "completed" as const,
                  input,
                  output: result?.output ?? "",
                  time: { start: toolStart, end: toolEnd || toolStart, duration: toolDuration },
                  metadata: buildEditDiffMetadata(normalizedTool, input),
                };

            parts.push({
              type: "step-start",
              id: timeId("pt"),
              messageId: msgId,
              sessionId,
            } as StepStartPart);
            parts.push({
              type: "tool",
              id: timeId("pt"),
              messageId: msgId,
              sessionId,
              callId: block.id,
              normalizedTool,
              originalTool: block.name,
              title: block.name,
              kind: inferToolKind(undefined, normalizedTool),
              state: toolState,
            } as ToolPart);
            parts.push({
              type: "step-finish",
              id: timeId("pt"),
              messageId: msgId,
              sessionId,
            } as StepFinishPart);
          }
        }
      }

      // Use the next message's timestamp as completion time
      const completedTs = tsOf(sdkMessages[index + 1]);

      if (parts.length === 0) continue;

      if (mergeInto) {
        mergeInto.parts.push(...parts);
        mergeInto.time.completed = completedTs || msgTs || mergeInto.time.completed;
        continue;
      }

      const message: UnifiedMessage = {
        id: msgId,
        sessionId,
        role: "assistant",
        time: {
          created: msgTs || Date.now(),
          completed: completedTs || msgTs || undefined,
        },
        parts,
      };
      messages.push(message);
      lastAssistant = { message, apiId };
    }
  }

  return messages;
}
