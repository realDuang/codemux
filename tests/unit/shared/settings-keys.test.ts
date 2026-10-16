import { describe, expect, it } from "vitest";
import { isSharedSettingsKey, isValidSharedSettingValue } from "../../../shared/settings-keys";

describe("reasoning effort settings", () => {
  it("accepts ultra for persisted engine defaults while rejecting unknown levels", () => {
    expect(isValidSharedSettingValue("engineReasoningEfforts", { codex: "ultra", claude: "high" })).toBe(true);
    expect(isValidSharedSettingValue("engineReasoningEfforts", { codex: "turbo" })).toBe(false);
  });
});

describe("project path filter settings", () => {
  it("shares project filters and rejects malformed paths before persistence", () => {
    expect(isSharedSettingsKey("projectPathFilter")).toBe(true);
    expect(isValidSharedSettingValue("projectPathFilter", { whitelist: ["/repo"], blacklist: ["/repo/private"] })).toBe(true);
    expect(isValidSharedSettingValue("projectPathFilter", { whitelist: ["relative"], blacklist: [] })).toBe(false);
    expect(isValidSharedSettingValue("projectPathFilter", { whitelist: [], blacklist: [], constructor: {} })).toBe(false);
  });
});
