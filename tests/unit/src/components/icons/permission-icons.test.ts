import { describe, expect, it } from "vitest";
import { KIND_ICON_PATHS, getKindIconPath } from "../../../../../src/components/icons/permission-icons";

describe("permission-icons", () => {
  it("returns tool-specific icon when toolName matches", () => {
    expect(getKindIconPath("other", "shell")).toBe(KIND_ICON_PATHS.shell);
    expect(getKindIconPath("read", "web_fetch")).toBe(KIND_ICON_PATHS.web_fetch);
  });

  it("falls back to kind-based icon when toolName has no match", () => {
    expect(getKindIconPath("edit")).toBe(KIND_ICON_PATHS.edit);
    expect(getKindIconPath("read")).toBe(KIND_ICON_PATHS.read);
  });

  it("returns 'other' gear icon for unknown kind", () => {
    expect(getKindIconPath("unknown_kind")).toBe(KIND_ICON_PATHS.other);
  });
});
