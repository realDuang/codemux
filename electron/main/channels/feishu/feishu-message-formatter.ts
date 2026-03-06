// ============================================================================
// Feishu Message Formatter
// Converts UnifiedPart arrays into clean text suitable for Feishu messages.
// Filters out internal details (reasoning, tool calls, steps) and keeps
// only user-visible content.
// ============================================================================

import type { UnifiedPart } from "../../../../src/types/unified";

/** Maximum Feishu message size in bytes (roughly 30KB for text) */
const MAX_MESSAGE_BYTES = 28_000;
const TRUNCATION_NOTICE = "\n\n... (content truncated, view full response in CodeMux)";

/**
 * Extract user-visible text from a list of UnifiedParts.
 * Only text parts are included; reasoning, tools, steps, etc. are filtered out.
 */
export function formatPartsToText(parts: UnifiedPart[]): string {
  const textParts: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          textParts.push(part.text);
        }
        break;
      // All other part types are intentionally not displayed in Feishu:
      // - reasoning: internal thought process
      // - tool: individual tool call details
      // - step-start/step-finish: step markers
      // - file/patch/snapshot: code file operations
      default:
        break;
    }
  }

  return textParts.join("");
}

/**
 * Generate a brief summary of tool calls from parts.
 * Example output: "Executed 3 actions: Shell(2), Edit(1)"
 */
export function formatToolSummary(parts: UnifiedPart[]): string {
  const toolCounts = new Map<string, number>();

  for (const part of parts) {
    if (part.type === "tool" && part.normalizedTool) {
      const name = part.normalizedTool;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }

  if (toolCounts.size === 0) return "";

  const total = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
  const details = Array.from(toolCounts.entries())
    .map(([name, count]) => `${capitalize(name)}(${count})`)
    .join(", ");

  return `\n\n---\nExecuted ${total} action${total > 1 ? "s" : ""}: ${details}`;
}

/**
 * Build a tool summary string from a tool counts map.
 * Used by streaming sessions that track tool counts incrementally.
 */
export function formatToolSummaryFromCounts(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) return "";

  const total = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
  const details = Array.from(toolCounts.entries())
    .map(([name, count]) => `${capitalize(name)}(${count})`)
    .join(", ");

  return `\n\n---\nExecuted ${total} action${total > 1 ? "s" : ""}: ${details}`;
}

/**
 * Truncate text to fit Feishu message size limit.
 * Returns the truncated text (single string).
 */
export function truncateForFeishu(text: string, maxBytes = MAX_MESSAGE_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  if (bytes.length <= maxBytes) {
    return text;
  }

  // Iteratively shrink to find the right truncation point
  const noticeBytes = encoder.encode(TRUNCATION_NOTICE).length;
  const targetBytes = maxBytes - noticeBytes;

  // Start with a conservative character estimate (UTF-8 chars are 1-4 bytes)
  let truncateAt = Math.floor(targetBytes / 3);
  while (encoder.encode(text.slice(0, truncateAt)).length > targetBytes && truncateAt > 0) {
    truncateAt = Math.floor(truncateAt * 0.9);
  }

  return text.slice(0, truncateAt) + TRUNCATION_NOTICE;
}

/**
 * Format the streaming "thinking" indicator text.
 */
export function formatStreamingText(textBuffer: string): string {
  if (!textBuffer) {
    return "Thinking...";
  }
  return textBuffer + "\n\n_Thinking..._";
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
