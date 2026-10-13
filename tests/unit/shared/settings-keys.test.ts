import { describe, expect, it } from "vitest";
import { isValidSharedSettingValue } from "../../../shared/settings-keys";

describe("reasoning effort settings", () => {
  it("accepts ultra for persisted engine defaults while rejecting unknown levels", () => {
    expect(isValidSharedSettingValue("engineReasoningEfforts", { codex: "ultra", claude: "high" })).toBe(true);
    expect(isValidSharedSettingValue("engineReasoningEfforts", { codex: "turbo" })).toBe(false);
  });
});
