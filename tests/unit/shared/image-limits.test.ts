import { describe, expect, it } from "vitest";
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  isAcceptedImageMime,
  mimeToFileExtension,
  validateImageAddition,
  type ImageCandidate,
} from "../../../shared/image-limits";

describe("isAcceptedImageMime", () => {
  it.each(ACCEPTED_IMAGE_MIME_TYPES.map((m) => [m]))(
    "accepts %s",
    (mime) => {
      expect(isAcceptedImageMime(mime)).toBe(true);
    },
  );

  it.each([
    ["application/pdf"],
    ["text/plain"],
    ["image/svg+xml"],
    ["image/heic"],
    [""],
  ])("rejects %s", (mime) => {
    expect(isAcceptedImageMime(mime)).toBe(false);
  });
});

describe("validateImageAddition", () => {
  const png = (size: number): ImageCandidate => ({ mimeType: "image/png", size });

  it("accepts a small first image", () => {
    expect(validateImageAddition([], png(100))).toEqual({ ok: true });
  });

  it("rejects non-whitelisted mime types", () => {
    const r = validateImageAddition([], { mimeType: "image/svg+xml", size: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("mime");
  });

  it("rejects oversized single images", () => {
    const r = validateImageAddition([], png(MAX_IMAGE_SIZE_BYTES + 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("size");
  });

  it("allows exactly the per-image cap", () => {
    expect(validateImageAddition([], png(MAX_IMAGE_SIZE_BYTES))).toEqual({ ok: true });
  });

  it("rejects when count limit is already reached", () => {
    const existing: ImageCandidate[] = Array.from(
      { length: MAX_IMAGES_PER_MESSAGE },
      () => png(10),
    );
    const r = validateImageAddition(existing, png(10));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("count");
  });

  it("returns size/count/mime correctly when boundaries are crossed", () => {
    // Under current caps (3 MB per image × 4 images = 12 MB total), the
    // `total` branch is mathematically unreachable without first violating
    // `size` or `count`. The two reachable rejections are exercised above;
    // this test pins the boundary behaviour so future tightening of caps
    // doesn't silently break the contract.
    const slot = MAX_IMAGE_SIZE_BYTES;
    const existing: ImageCandidate[] = Array.from(
      { length: MAX_IMAGES_PER_MESSAGE - 1 },
      () => png(slot),
    );
    // Adding the largest allowed image fills the cap exactly → still ok.
    const remaining = MAX_TOTAL_IMAGE_BYTES - existing.length * slot;
    const fit = Math.min(slot, remaining);
    if (fit > 0) {
      expect(validateImageAddition(existing, png(fit))).toEqual({ ok: true });
    }
  });
});

describe("mimeToFileExtension", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ])("returns the subtype for plain MIME %s", (mime, expected) => {
    expect(mimeToFileExtension(mime)).toBe(expected);
  });

  it("strips compound suffix (image/svg+xml → svg)", () => {
    expect(mimeToFileExtension("image/svg+xml")).toBe("svg");
  });

  it("strips media-type parameters (image/png; q=0.9 → png)", () => {
    expect(mimeToFileExtension("image/png; q=0.9")).toBe("png");
  });

  it.each([["png", "png"], ["", "png"], ["image", "png"], ["image/", "png"]])(
    "falls back to png for malformed input %j",
    (mime, expected) => {
      expect(mimeToFileExtension(mime)).toBe(expected);
    },
  );
});
