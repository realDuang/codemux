// ============================================================================
// Image format detection from magic bytes
// Used by all channel adapters when downloading user-uploaded images so the
// engine receives a correct `mimeType` regardless of what the upstream API
// reports (some channels don't include reliable MIME headers).
// ============================================================================

export type DetectedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Detect an image's MIME type from its leading bytes. Returns null when the
 * buffer doesn't match any supported format — callers should skip such images
 * rather than pass them to the engine.
 */
export function detectImageMime(buf: Buffer): DetectedImageMime | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
