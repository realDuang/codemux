import { Lexer } from "marked";
import type { ReasoningPart } from "../types/unified";

/** Other engines' reasoning is content, including its first heading or bold sentence. */
export function getReasoningDisplayText(part: ReasoningPart, isStreaming: boolean): string {
  return part.summaryFormat === "heading-prefixed" ? getReasoningBody(part.text, isStreaming) : part.text;
}

/** Remove only the leading summary heading, keeping subsequent sections intact. */
export function getReasoningBody(text: string, isStreaming: boolean): string {
  const trimmed = text.trimStart();
  const bold = trimmed.match(/^\*\*[^\n]*?\*\*/);
  if (isStreaming) {
    if (bold) return trimmed.slice(bold[0].length).trimStart();
    return trimmed.startsWith("**") ? "" : trimmed;
  }
  if (bold) return trimmed.slice(bold[0].length).trim();
  try {
    // Marked normalizes line endings before it computes each token's raw range.
    const normalized = text.replace(/\r\n?/g, "\n");
    const tokens = Lexer.lex(normalized);
    let offset = 0;
    for (const token of tokens) {
      if (token.type === "space") {
        offset += token.raw.length;
        continue;
      }
      const isStrongParagraph = token.type === "paragraph" &&
        token.tokens?.length === 1 && token.tokens[0].type === "strong";
      return token.type === "heading" || isStrongParagraph
        ? normalized.slice(offset + token.raw.length).trim()
        : text;
    }
  } catch {
    return text;
  }
  return text;
}

/** Restored summaries without an authoritative interval have no elapsed label. */
export function getReasoningDuration(time: ReasoningPart["time"]): number | undefined {
  if (!time || !Number.isFinite(time.start) || time.end === undefined ||
      !Number.isFinite(time.end) || time.start <= 0 || time.end <= time.start) return undefined;
  return time.end - time.start;
}
