import { describe, expect, it } from "vitest";
import { formatUpdateAvailableMessage, hasUpdateVersion } from "../../../../src/lib/update-message";

describe("formatUpdateAvailableMessage", () => {
  it("inserts the available update version into the localized template", () => {
    expect(
      formatUpdateAvailableMessage(
        "New version v{version} available",
        "1.8.0",
      ),
    ).toBe("New version v1.8.0 available");
  });
});

describe("hasUpdateVersion", () => {
  it.each([undefined, "", "   "])(
    "rejects missing version value %s",
    (version) => {
      expect(hasUpdateVersion(version)).toBe(false);
    },
  );

  it("accepts a non-empty version value", () => {
    expect(hasUpdateVersion("1.8.0")).toBe(true);
  });
});
