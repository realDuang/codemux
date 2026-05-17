// ============================================================================
// Feishu Message Content Parser
// Pure parsing utilities for Feishu (Lark) message events.
// Converts text/image/post message bodies into ordered content parts.
// ============================================================================

import type { MessagePromptContent } from "../../../../src/types/unified";

/** An ordered piece of message content extracted from a Feishu message body. */
export type ParsedContentPart =
  | { type: "text"; text: string }
  | { type: "image-key"; imageKey: string };

/** Result of parsing a Feishu message body. */
export interface ParsedFeishuMessage {
  /** Plain-text representation (used for commands, dedup keys, display). */
  text: string;
  /** Ordered parts (text + image-key) used for engine sending. */
  parts: ParsedContentPart[];
}

/** Strip Feishu @mention placeholders like `@_user_1` from plain text. */
export function stripFeishuMentions(value: string): string {
  return value.replace(/@_user_\d+/g, "");
}

/**
 * Parse a Feishu message event body into ordered content parts and plain text.
 *
 * Supported message types:
 *   - "text":  `{"text":"..."}`
 *   - "image": `{"image_key":"img_xxx"}`
 *   - "post":  `{"title":"...","content":[[ {tag:"text"|"a"|"at"|"code_inline"|"img", ...} ]]}`
 *
 * Unknown types yield `{ text: "", parts: [] }`.
 */
export function parseFeishuMessageContent(
  messageType: string,
  contentJson: string,
): ParsedFeishuMessage {
  if (messageType === "text") {
    return parseTextMessage(contentJson);
  }
  if (messageType === "image") {
    return parseImageMessage(contentJson);
  }
  if (messageType === "post") {
    return parsePostMessage(contentJson);
  }
  return { text: "", parts: [] };
}

function parseTextMessage(contentJson: string): ParsedFeishuMessage {
  let rawText = "";
  try {
    const parsed = JSON.parse(contentJson);
    rawText = typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    rawText = contentJson;
  }
  const text = stripFeishuMentions(rawText).trim();
  if (!text) return { text: "", parts: [] };
  return { text, parts: [{ type: "text", text }] };
}

function parseImageMessage(contentJson: string): ParsedFeishuMessage {
  let imageKey = "";
  try {
    const parsed = JSON.parse(contentJson);
    imageKey = typeof parsed?.image_key === "string" ? parsed.image_key : "";
  } catch {
    // Ignore parsing failure — treat as no image
  }
  if (!imageKey) return { text: "", parts: [] };
  return { text: "", parts: [{ type: "image-key", imageKey }] };
}

interface PostElement {
  tag?: unknown;
  text?: unknown;
  href?: unknown;
  user_name?: unknown;
  image_key?: unknown;
}

function parsePostMessage(contentJson: string): ParsedFeishuMessage {
  let post: { title?: unknown; content?: unknown } | null = null;
  try {
    post = JSON.parse(contentJson) as { title?: unknown; content?: unknown };
  } catch {
    return { text: "", parts: [] };
  }

  const parts: ParsedContentPart[] = [];
  const textBuf: string[] = [];

  const title = typeof post?.title === "string" ? post.title.trim() : "";
  if (title) {
    parts.push({ type: "text", text: title });
    textBuf.push(title);
  }

  const rows = Array.isArray(post?.content) ? (post.content as unknown[]) : [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const rowText: string[] = [];
    for (const el of row as PostElement[]) {
      if (!el || typeof el !== "object") continue;
      const tag = typeof el.tag === "string" ? el.tag : "";

      if (tag === "text" && typeof el.text === "string") {
        rowText.push(el.text);
      } else if (tag === "a" && typeof el.text === "string") {
        const href = typeof el.href === "string" ? el.href : "";
        rowText.push(href ? `[${el.text}](${href})` : el.text);
      } else if (tag === "at" && typeof el.user_name === "string") {
        rowText.push(`@${el.user_name}`);
      } else if (tag === "code_inline" && typeof el.text === "string") {
        rowText.push(`\`${el.text}\``);
      } else if (tag === "img" && typeof el.image_key === "string" && el.image_key) {
        // Flush pending row text before the image so ordering is preserved.
        if (rowText.length > 0) {
          const joined = rowText.join("");
          parts.push({ type: "text", text: joined });
          textBuf.push(joined);
          rowText.length = 0;
        }
        parts.push({ type: "image-key", imageKey: el.image_key });
      }
    }
    if (rowText.length > 0) {
      const joined = rowText.join("");
      parts.push({ type: "text", text: joined });
      textBuf.push(joined);
    }
  }

  // Strip mentions / trim each text part for safety
  const cleanedParts: ParsedContentPart[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      const cleaned = stripFeishuMentions(p.text).trim();
      if (cleaned) cleanedParts.push({ type: "text", text: cleaned });
    } else {
      cleanedParts.push(p);
    }
  }

  const text = stripFeishuMentions(textBuf.join("\n")).trim();
  return { text, parts: cleanedParts };
}

/**
 * Detect image MIME type from a buffer's leading bytes ("magic numbers").
 * Returns null when the format is not recognized — callers should skip such images.
 */
export function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/**
 * Build a MessagePromptContent[] from ordered parsed parts and a map of
 * already-downloaded image data keyed by image key. Parts whose image key is
 * missing from the map (e.g. download failed / size exceeded) are dropped.
 *
 * Consecutive text parts are joined with newlines to keep the payload small.
 */
export function buildPromptContent(
  parts: ParsedContentPart[],
  imageData: Map<string, { data: string; mimeType: string }>,
): MessagePromptContent[] {
  const out: MessagePromptContent[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length === 0) return;
    const joined = textBuf.join("\n").trim();
    if (joined) out.push({ type: "text", text: joined });
    textBuf = [];
  };

  for (const p of parts) {
    if (p.type === "text") {
      if (p.text.trim()) textBuf.push(p.text);
      continue;
    }
    const img = imageData.get(p.imageKey);
    if (!img) continue;
    flushText();
    out.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  flushText();

  return out;
}
