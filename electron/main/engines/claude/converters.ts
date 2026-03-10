/**
 * Claude Code adapter — pure conversion helpers.
 * Transforms Claude SDK types into the unified CodeMux message format.
 */

import type {
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { timeId } from "../../utils/id-gen";
import { normalizeToolName, inferToolKind } from "../../../../src/types/tool-mapping";
import type {
  EngineType,
  UnifiedSession,
  UnifiedMessage,
  UnifiedPart,
  TextPart,
  ReasoningPart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
} from "../../../../src/types/unified";

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

  // Build a lookup from tool_use_id → next user message timestamp.
  // In the .jsonl, a tool_use block in an assistant message is followed by
  // a user message containing the tool_result. The time between the assistant
  // message and the tool_result user message is the tool execution duration.
  const toolResultTimestamps = new Map<string, number>();
  if (timestamps && timestamps.size > 0) {
    for (const msg of sdkMessages) {
      if (msg.type !== "user") continue;
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      const msgTs = timestamps.get(msg.uuid);
      if (!msgTs) continue;
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultTimestamps.set(block.tool_use_id, msgTs);
        }
      }
    }
  }

  for (const msg of sdkMessages) {
    const msgTs = timestamps?.get(msg.uuid) ?? 0;

    if (msg.type === "user") {
      const msgId = msg.uuid ?? timeId("msg");
      const parts: UnifiedPart[] = [];
      const content = msg.message?.content;

      if (typeof content === "string") {
        parts.push({ type: "text", text: content, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
          }
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
      }
    } else if (msg.type === "assistant") {
      const msgId = msg.uuid ?? timeId("msg");
      const parts: UnifiedPart[] = [];
      const content = msg.message?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text, id: timeId("pt"), messageId: msgId, sessionId } as TextPart);
          } else if (block.type === "thinking") {
            parts.push({
              type: "reasoning",
              text: block.thinking,
              id: timeId("pt"),
              messageId: msgId,
              sessionId,
            } as ReasoningPart);
          } else if (block.type === "tool_use") {
            const normalizedTool = normalizeToolName("claude", block.name ?? "");

            // Calculate tool duration from timestamps
            const toolStart = msgTs;
            const toolEnd = toolResultTimestamps.get(block.id) ?? 0;
            const toolDuration = (toolStart && toolEnd && toolEnd > toolStart)
              ? toolEnd - toolStart
              : 0;

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
              state: {
                status: "completed",
                input: block.input ?? {},
                output: "",
                time: { start: toolStart, end: toolEnd || toolStart, duration: toolDuration },
              },
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

      // Find the next message's timestamp to use as completion time
      const msgIndex = sdkMessages.indexOf(msg);
      const nextMsg = sdkMessages[msgIndex + 1];
      const completedTs = nextMsg ? (timestamps?.get(nextMsg.uuid) ?? 0) : 0;

      if (parts.length > 0) {
        messages.push({
          id: msgId,
          sessionId,
          role: "assistant",
          time: {
            created: msgTs || Date.now(),
            completed: completedTs || msgTs || undefined,
          },
          parts,
        });
      }
    }
  }

  return messages;
}
