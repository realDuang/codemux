import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lexer } from "marked";
import { detectImageMime } from "../../channels/shared/image-detector";
import { MAX_IMAGE_SIZE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_TOTAL_IMAGE_BYTES } from "../../../../shared/image-limits";
import type { FilePart, TextPart } from "../../../../src/types/unified";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_MIMES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_CANDIDATES = 32;
interface CachedImage { fingerprint: string; mime: string; url: string; size: number }
const imageCache = new Map<string, CachedImage>();
let cachedBytes = 0;

function visualizationPath(path: string, home: string, threadId: string): boolean {
  const parts = relative(home, path).split(sep);
  if (parts.length < 6 || parts[0] !== "visualizations" || parts[4] !== threadId
    || !/^\d{4}$/.test(parts[1]) || !/^\d{2}$/.test(parts[2]) || !/^\d{2}$/.test(parts[3])
    || parts.some((part) => !part || part === "." || part === "..")) return false;
  const date = parts.slice(1, 4).join("-");
  const instant = new Date(`${date}T00:00:00.000Z`);
  return !date.startsWith("0000-") && Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date;
}

function readVisualization(source: string, home: string, threadId: string): CachedImage | undefined {
  let descriptor: number | undefined;
  try {
    const path = /^file:/i.test(source) ? fileURLToPath(source) : decodeURIComponent(source);
    if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)
      || path.slice(parse(path).root.length).split(/[\\/]/).some((part) => !part || part === "." || part === "..")
      || !visualizationPath(path, home, threadId)) return;
    const expectedMime = IMAGE_MIMES[extname(path).toLowerCase()];
    if (!expectedMime) return;
    const realHome = realpathSync(home);
    const realPath = realpathSync(path);
    if (!visualizationPath(realPath, realHome, threadId)) return;

    // Read a bounded regular-file descriptor; never turn the reference into directory access.
    descriptor = openSync(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_SIZE_BYTES) return;
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const cached = imageCache.get(realPath);
    if (cached?.fingerprint === fingerprint && cached.mime === expectedMime) return cached;

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!read) return;
      offset += read;
    }
    const after = fstatSync(descriptor);
    if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":") !== fingerprint) return;
    const mime = detectImageMime(buffer);
    if (mime !== expectedMime) return;
    const image = { fingerprint, mime, url: `data:${mime};base64,${buffer.toString("base64")}`, size: buffer.length };
    if (cached) { cachedBytes -= cached.size; imageCache.delete(realPath); }
    // A Desktop patch reprojects history. Bound cached bytes and entries across followed chats.
    while (imageCache.size >= 128 || cachedBytes + image.size > MAX_TOTAL_IMAGE_BYTES) {
      const oldest = imageCache.keys().next().value;
      if (!oldest) break;
      cachedBytes -= imageCache.get(oldest)!.size;
      imageCache.delete(oldest);
    }
    imageCache.set(realPath, image);
    cachedBytes += image.size;
    return image;
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Attach only completed native assistant references from this thread's visualization directory. */
export function withCodexAssistantImages(
  part: TextPart,
  threadId: unknown,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): TextPart {
  if (!part.completed || typeof threadId !== "string" || !UUID.test(threadId) || !isAbsolute(codexHome)) return part;
  const text = part.displayText ?? part.text;
  if (!text.includes("![")) return part;
  const inlineAssets: FilePart[] = [];
  let totalBytes = 0;
  let candidates = 0;
  for (const token of lexer(text)) {
    if (inlineAssets.length >= MAX_IMAGES_PER_MESSAGE) break;
    // Standalone image paragraphs are display intent; code and links never authorize reads.
    if (token.type !== "paragraph" || token.tokens?.length !== 1 || token.tokens[0].type !== "image") continue;
    const imageToken = token.tokens[0];
    if (inlineAssets.some((asset) => asset.sourcePath === imageToken.href)) continue;
    if (candidates++ >= MAX_IMAGE_CANDIDATES) break;
    const image = readVisualization(imageToken.href, codexHome, threadId);
    if (!image || totalBytes + image.size > MAX_TOTAL_IMAGE_BYTES) continue;
    totalBytes += image.size;
    inlineAssets.push({
      id: `${part.id}:inline-image:${inlineAssets.length}`, messageId: part.messageId, sessionId: part.sessionId,
      type: "file", mime: image.mime, url: image.url, sourcePath: imageToken.href,
      filename: imageToken.text || basename(imageToken.href),
    });
  }
  return inlineAssets.length ? { ...part, inlineAssets } : part;
}
