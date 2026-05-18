import { describe, expect, it } from "vitest";
import { detectImageMime } from "../../../../../electron/main/channels/shared/image-detector";

describe("detectImageMime", () => {
  it("detects PNG by 8-byte signature", () => {
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    expect(detectImageMime(buf)).toBe("image/png");
  });

  it("detects JPEG by 3-byte SOI", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
    expect(detectImageMime(buf)).toBe("image/jpeg");
  });

  it.each([
    ["GIF87a", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
    ["GIF89a", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ])("detects %s", (_label, bytes) => {
    expect(detectImageMime(Buffer.from(bytes))).toBe("image/gif");
  });

  it("detects WebP via RIFF...WEBP", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0, 0, 0, 0,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMime(buf)).toBe("image/webp");
  });

  it("returns null for unknown headers and tiny buffers", () => {
    expect(detectImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(detectImageMime(Buffer.from([]))).toBeNull();
    expect(detectImageMime(Buffer.from([0x89]))).toBeNull();
  });

  it("returns null when GIF marker is not 87a or 89a", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x33, 0x61]);
    expect(detectImageMime(buf)).toBeNull();
  });

  it("returns null when RIFF header lacks WEBP marker", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0, 0, 0, 0,
      0x57, 0x41, 0x56, 0x45, // "WAVE" instead
    ]);
    expect(detectImageMime(buf)).toBeNull();
  });
});
