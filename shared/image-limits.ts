// ============================================================================
// Shared image attachment limits (frontend + channel adapters)
//
// Why these numbers:
//   - Gateway WS payload cap is 20 MB (electron/main/gateway/ws-server.ts).
//   - base64 inflates raw bytes by ~33%.
//   - JSON wrapping + text content + safety margin reserves ~4 MB.
//   - That leaves ~12 MB raw bytes per message for image payload.
//
// Single source of truth so the frontend, all channel adapters, and the
// gateway-side persistence path can stay consistent.
// ============================================================================

/** Max raw bytes for a single image attachment. */
export const MAX_IMAGE_SIZE_BYTES = 3 * 1024 * 1024;

/** Max image attachments per outgoing message. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Max total raw bytes across all images in a single outgoing message. */
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

/** Whitelisted MIME types. */
export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];

export interface ImageCandidate {
  /** Raw byte size before base64 encoding. */
  size: number;
  /** MIME type. */
  mimeType: string;
}

export type ImageRejectionReason = "mime" | "size" | "count" | "total";

export interface ImageValidationResult {
  ok: boolean;
  reason?: ImageRejectionReason;
}

/**
 * Validate whether `candidate` may be added to the existing set of images for
 * the same outgoing message. Pure function — safe to call from both renderer
 * and main processes.
 */
export function validateImageAddition(
  existing: readonly ImageCandidate[],
  candidate: ImageCandidate,
): ImageValidationResult {
  if (!isAcceptedImageMime(candidate.mimeType)) {
    return { ok: false, reason: "mime" };
  }
  if (candidate.size > MAX_IMAGE_SIZE_BYTES) {
    return { ok: false, reason: "size" };
  }
  if (existing.length >= MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, reason: "count" };
  }
  const totalAfter = existing.reduce((sum, img) => sum + img.size, 0) + candidate.size;
  if (totalAfter > MAX_TOTAL_IMAGE_BYTES) {
    return { ok: false, reason: "total" };
  }
  return { ok: true };
}

export function isAcceptedImageMime(mime: string): mime is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}
