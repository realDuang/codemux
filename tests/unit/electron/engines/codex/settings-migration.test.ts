import { describe, expect, it } from "vitest";
import { codexSettingsMigration } from "../../../../../electron/main/engines/codex/settings-migration";

describe("codexSettingsMigration", () => {
  it("preserves the previously selected variant and leaves recovery keys and other engines intact", () => {
    const settings = { defaultEngine: "codex-desktop", engineModels: {
      codex: { modelID: "direct", providerID: "modelhub", enabled: true },
      "codex-desktop": { modelID: "shared", enabled: false }, claude: { modelID: "other" },
    }, engineReasoningEfforts: { codex: "high", "codex-desktop": "ultra" },
    "orchestration.roleMapping": [{ role: "planner", engineType: "codex-desktop" }, { role: "reviewer", engineType: "claude" }] };
    const patch = codexSettingsMigration(settings)!;
    expect(patch.defaultEngine).toBe("codex");
    expect(patch.engineModels).toEqual({ ...settings.engineModels, codex: { providerID: "modelhub", modelID: "shared", enabled: false } });
    expect(patch.engineReasoningEfforts).toEqual({ codex: "ultra", "codex-desktop": "ultra" });
    expect(patch["orchestration.roleMapping"]).toEqual([{ role: "planner", engineType: "codex" }, { role: "reviewer", engineType: "claude" }]);
    expect(settings.engineModels.codex.modelID).toBe("direct");
  });

  it("keeps explicit unified preferences and applies the migration only once", () => {
    expect(codexSettingsMigration({ engineServiceTiers: { codex: "flex", "codex-desktop": "fast" } })?.engineServiceTiers)
      .toEqual({ codex: "flex", "codex-desktop": "fast" });
    expect(codexSettingsMigration({ codexUnifiedSettingsVersion: 1, defaultEngine: "codex-desktop" })).toBeUndefined();
  });

  it.each(["codex", "codex-desktop"])("retains an explicitly cleared tier for the preferred %s variant", defaultEngine => {
    const tiers = defaultEngine === "codex"
      ? { codex: null, "codex-desktop": "fast" }
      : { codex: "fast", "codex-desktop": null };
    expect(codexSettingsMigration({ defaultEngine, engineServiceTiers: tiers })?.engineServiceTiers)
      .toEqual({ ...tiers, codex: null });
  });
});
