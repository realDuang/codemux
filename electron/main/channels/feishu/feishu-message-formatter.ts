// ============================================================================
// Feishu Message Formatter
// Converts UnifiedPart arrays into clean text suitable for Feishu messages.
// Filters out internal details (reasoning, tool calls, steps) and keeps
// only user-visible content.
// ============================================================================

/** Maximum Feishu message size in bytes (roughly 30KB for text) */
const MAX_MESSAGE_BYTES = 28_000;
const TRUNCATION_NOTICE = "\n\n...（内容已截断，请在 CodeMux 中查看完整回复）";

/**
 * Build a tool summary string from a tool counts map.
 * Used by streaming sessions that track tool counts incrementally.
 * Example output: "Executed 3 actions: Shell(2), Edit(1)"
 */
export function formatToolSummaryFromCounts(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) return "";

  const total = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
  const details = Array.from(toolCounts.entries())
    .map(([name, count]) => `${capitalize(name)}(${count})`)
    .join(", ");

  return `\n\n---\n执行了 ${total} 个操作：${details}`;
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

/**
 * Build a brief hint message for new P2P temp sessions.
 * Shown once after the first reply completes to help users discover commands.
 */
export function buildTempSessionHintText(): string {
  return "💡 发送 /help 查看所有命令 | 发送 /project 选择项目并创建专属群聊会话";
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
