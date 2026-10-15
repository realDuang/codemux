import {
  isAcceptedImageMime,
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  mimeToFileExtension,
} from "../../../../shared/image-limits";
import type { FilePart } from "../../../../src/types/unified";

interface PartIdentity {
  id: string;
  messageId: string;
  sessionId: string;
}

const MAX_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4 + 128;
const MAX_LINK_LENGTH = 8192;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_LINK_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function imageMime(path: string): string | undefined {
  const extension = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[extension ?? ""];
}

function imageDataUrl(mime: unknown, data: unknown): string | undefined {
  if (typeof mime !== "string" || !isAcceptedImageMime(mime) || typeof data !== "string") return undefined;
  if (!data || data.length > MAX_DATA_URL_LENGTH - 128 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  return `data:${mime};base64,${data}`;
}

function explicitImageUrl(value: unknown): { url: string; mime: string } | undefined {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_LENGTH) return undefined;
  const data = /^data:(image\/[a-z]+);base64,([\s\S]*)$/.exec(value);
  if (data) {
    const url = imageDataUrl(data[1], data[2]);
    return url ? { url, mime: data[1] } : undefined;
  }
  const url = httpsUrl(value);
  return url ? { url, mime: imageMime(url) ?? "image/png" } : undefined;
}

/** Keep readable structured output without copying binary payloads into the tool log. */
function readableJson(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key, entry: unknown) {
    const parent = record(this);
    if (key === "blob" || (key === "data" && ["image", "audio"].includes(String(parent?.type)))) return "[binary content omitted]";
    if (typeof entry === "string" && /^data:(?:image|audio)\//.test(entry)) return "[inline media omitted]";
    return entry;
  }, 2) ?? "";
}

/** Normalize the public app-server rich tool result shapes into the shared stream. */
export function extractCodexToolOutput(
  value: unknown,
  base: PartIdentity,
): { output: unknown; attachments: FilePart[] } {
  const item = record(value);
  if (!item) return { output: undefined, attachments: [] };
  const attachments: FilePart[] = [];
  const text: string[] = [];
  let imageCount = 0;
  const addAttachment = (index: number, fields: Pick<FilePart, "url" | "mime" | "filename" | "sourcePath">) => {
    if (attachments.length >= 16) return;
    if (isAcceptedImageMime(fields.mime) && imageCount++ >= MAX_IMAGES_PER_MESSAGE) return;
    attachments.push({ ...base, id: `${base.id}:attachment:${index}`, type: "file", ...fields });
  };
  const addImage = (index: number, url: unknown, name?: string) => {
    const image = explicitImageUrl(url);
    if (image) addAttachment(index, { ...image, filename: name || `image-${index + 1}.${mimeToFileExtension(image.mime)}` });
  };
  const addResource = (index: number, resource: Record<string, unknown>, embedded: boolean) => {
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    const name = typeof resource.name === "string" ? resource.name : uri.split("/").pop() || `resource-${index + 1}`;
    const mime = typeof resource.mimeType === "string" ? resource.mimeType : imageMime(uri) ?? "application/octet-stream";
    if (embedded && typeof resource.text === "string") text.push(resource.text);
    const data = embedded ? imageDataUrl(mime, resource.blob) : undefined;
    const url = data ?? httpsUrl(uri);
    if (url) addAttachment(index, { url, mime, filename: name });
    else if (uri) text.push(uri);
  };

  if (item.type === "imageGeneration") {
    if (typeof item.savedPath === "string" && item.savedPath && !/[\u0000-\u001f]/.test(item.savedPath)) {
      const mime = imageMime(item.savedPath);
      if (mime) addAttachment(0, { url: "", mime, filename: item.savedPath.split(/[\\/]/).pop()!, sourcePath: item.savedPath });
    }
    if (attachments.length === 0) addImage(0, item.result);
    return { output: attachments.length ? item.savedPath ?? item.revisedPrompt ?? "" : item.result, attachments };
  }

  const result = record(item.result);
  if (item.type === "functionCallOutput" && typeof item.output === "string") {
    return { output: item.output, attachments };
  }
  const content = item.type === "mcpToolCall" ? result?.content
    : item.type === "dynamicToolCall" ? item.contentItems
      : item.type === "functionCallOutput" ? item.output : undefined;
  if (!Array.isArray(content)) return { output: item.result, attachments };
  content.forEach((entry, index) => {
    const block = record(entry);
    if (!block) {
      text.push(readableJson(entry));
      return;
    }
    switch (block.type) {
      case "text":
      case "inputText":
      case "input_text":
        if (typeof block.text === "string") text.push(block.text);
        break;
      case "image": {
        const url = imageDataUrl(block.mimeType, block.data);
        if (url) addImage(index, url);
        break;
      }
      case "inputImage":
        addImage(index, block.imageUrl);
        break;
      case "input_image":
        if (typeof block.image_url === "string") addImage(index, block.image_url);
        else text.push(readableJson(block));
        break;
      case "encrypted_content":
        // Opaque model state is not a visible tool result.
        break;
      case "resource_link":
        addResource(index, block, false);
        break;
      case "resource": {
        const resource = record(block.resource);
        if (resource) addResource(index, resource, true);
        break;
      }
      default:
        text.push(readableJson(block));
    }
  });
  if (result?.structuredContent != null) text.push(readableJson(result.structuredContent));
  return { output: text.join("\n"), attachments };
}
