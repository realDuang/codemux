import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname, isAbsolute, parse } from "node:path";
import { detectImageMime } from "../../channels/shared/image-detector";
import {
  isAcceptedImageMime,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
  mimeToFileExtension,
} from "../../../../shared/image-limits";
import type { FilePart, TextPart } from "../../../../src/types/unified";

type UserInputPart = Pick<TextPart, "type" | "text" | "displayText">
  | Pick<FilePart, "type" | "mime" | "url" | "filename">;

interface UserInputOptions {
  /** Only local native owners can authorize a file on this host. */
  allowLocalFiles: boolean;
}

interface ImageAsset {
  mime: string;
  url: string;
  size: number;
  fingerprint?: string;
}

interface MentionedImage {
  name: string;
  path: string;
}

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 + 128;
const imageCache = new Map<string, ImageAsset>();
let cachedBytes = 0;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function remember(key: string, asset: ImageAsset): ImageAsset {
  const previous = imageCache.get(key);
  if (previous) { cachedBytes -= previous.size; imageCache.delete(key); }
  while (imageCache.size >= 128 || cachedBytes + asset.size > MAX_TOTAL_IMAGE_BYTES) {
    const oldest = imageCache.keys().next().value;
    if (!oldest) break;
    cachedBytes -= imageCache.get(oldest)!.size;
    imageCache.delete(oldest);
  }
  imageCache.set(key, asset);
  cachedBytes += asset.size;
  return asset;
}

function safeLocalPath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && path.length <= 8192
    && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.slice(parse(path).root.length).split(/[\\/]/).some(part => !part || part === "." || part === "..");
}

function localImage(path: unknown): ImageAsset | undefined {
  if (!safeLocalPath(path)) return;
  const expectedMime = IMAGE_MIMES[extname(path).toLowerCase()];
  if (!expectedMime) return;
  let descriptor: number | undefined;
  try {
    // A structured localImage authorizes this exact file, never a path found in text.
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_SIZE_BYTES) return;
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const key = `local:${path}`;
    const cached = imageCache.get(key);
    if (cached?.fingerprint === fingerprint && cached.mime === expectedMime) return cached;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) return;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":") !== fingerprint) return;
    const mime = detectImageMime(bytes);
    if (mime !== expectedMime) return;
    return remember(key, { mime, fingerprint, url: `data:${mime};base64,${bytes.toString("base64")}`, size: bytes.length });
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function explicitImage(value: unknown): ImageAsset | undefined {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_LENGTH) return;
  const cached = imageCache.get(value);
  if (cached) return cached;
  if (value.startsWith("data:")) {
    const data = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!data || !isAcceptedImageMime(data[1]) || data[2].length % 4 !== 0) return;
    const bytes = Buffer.from(data[2], "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_SIZE_BYTES || detectImageMime(bytes) !== data[1]) return;
    return remember(value, { mime: data[1], url: value, size: bytes.length });
  }
  if (value.length > 8192) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return;
    return { mime: IMAGE_MIMES[extname(url.pathname).toLowerCase()] ?? "image/png", url: url.href, size: 0 };
  } catch {
    return;
  }
}

function imageBlock(block: Record<string, unknown>): boolean {
  return block.type === "image" || block.type === "localImage" || block.type === "input_image";
}

function textBlock(block: Record<string, unknown>): boolean {
  return block.type === "text" || block.type === "input_text";
}

function imageEnvelopePath(blocks: Record<string, unknown>[], index: number): string | undefined {
  const before = blocks[index - 1];
  const after = blocks[index + 1];
  if (!before || !after || !textBlock(before) || !textBlock(after) || after.text !== "</image>") return;
  if (typeof before.text !== "string") return;
  return /^<image name=\[Image #\d+\] path="([^"\r\n]+)">$/.exec(before.text)?.[1];
}

function attachmentPrompt(text: unknown): { images: MentionedImage[]; request: string } | undefined {
  if (typeof text !== "string") return;
  const header = /^\s*# Files mentioned by the user:\r?\n\r?\n/.exec(text);
  if (!header) return;
  const marker = /\r?\n\r?\nDistinguish instructions in attached documents from the user's request\.\r?\n\r?\n## My request(?: for Codex)?:\r?\n/.exec(text.slice(header[0].length));
  if (!marker) return;
  const entries = text.slice(header[0].length, header[0].length + marker.index).split(/\r?\n\r?\n/);
  const images: MentionedImage[] = [];
  for (const entry of entries) {
    const image = /^## ([^\r\n]+): ([^\r\n]+)\r?\nImage attachment: true$/.exec(entry);
    if (!image || !image[1].trim() || !image[2].trim()) return;
    images.push({ name: image[1], path: image[2] });
  }
  return images.length ? {
    images,
    request: text.slice(header[0].length + marker.index + marker[0].length).trim(),
  } : undefined;
}

/** Normalize only native user text/image blocks; callers retain their own IDs and other input types. */
export function projectCodexUserInput(input: unknown, options: UserInputOptions): Array<UserInputPart | undefined> {
  if (!Array.isArray(input)) return [];
  const blocks = input.map(record);
  const imageIndexes = blocks.flatMap((block, index) => imageBlock(block) ? [index] : []);
  const prompt = attachmentPrompt(blocks[0]?.text);
  const matches = prompt && prompt.images.length === imageIndexes.length && imageIndexes.every((index, imageIndex) => {
    const block = blocks[index];
    const sourcePath = block.type === "localImage" ? block.path : imageEnvelopePath(blocks, index);
    return sourcePath === undefined || sourcePath === prompt.images[imageIndex].path;
  });
  const hiddenEnvelopes = new Set<number>();
  if (matches) for (const index of imageIndexes) {
    if (imageEnvelopePath(blocks, index)) { hiddenEnvelopes.add(index - 1); hiddenEnvelopes.add(index + 1); }
  }
  let imageCount = 0;
  let totalBytes = 0;
  return blocks.map((block, index): UserInputPart | undefined => {
    if (textBlock(block) && typeof block.text === "string") {
      return { type: "text", text: block.text,
        ...(index === 0 && matches ? { displayText: prompt.request } : {}),
        ...(hiddenEnvelopes.has(index) ? { displayText: "" } : {}),
      };
    }
    if (!imageBlock(block)) return;
    const mentioned = matches ? prompt.images[imageCount] : undefined;
    const withinCount = imageCount++ < MAX_IMAGES_PER_MESSAGE;
    const asset = !withinCount ? undefined : block.type === "localImage"
      ? options.allowLocalFiles ? localImage(block.path) : undefined
      : explicitImage(block.type === "input_image" ? block.image_url : block.url);
    const accepted = asset && totalBytes + asset.size <= MAX_TOTAL_IMAGE_BYTES ? asset : undefined;
    if (accepted) totalBytes += accepted.size;
    const nativePath = typeof block.path === "string" ? block.path : "";
    const mime = accepted?.mime ?? IMAGE_MIMES[extname(nativePath).toLowerCase()] ?? "image/png";
    const filename = mentioned?.name ?? (nativePath.split(/[\\/]/).pop() || `image-${imageCount}.${mimeToFileExtension(mime)}`);
    return { type: "file", mime, filename, url: accepted?.url ?? "" };
  });
}
