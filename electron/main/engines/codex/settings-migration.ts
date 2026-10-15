/** Preserve the preferred legacy variant's defaults when the public engines merge. */
export function codexSettingsMigration(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  if (settings.codexUnifiedSettingsVersion === 1) return undefined;
  const preferDesktop = settings.defaultEngine === "codex-desktop";
  const patch: Record<string, unknown> = { codexUnifiedSettingsVersion: 1 };
  for (const key of ["engineModels", "engineReasoningEfforts", "engineServiceTiers"]) {
    const entries = record(settings[key]);
    if (!Object.hasOwn(entries, "codex-desktop")) continue;
    const direct = entries.codex;
    const desktop = entries["codex-desktop"];
    const value = key === "engineModels"
      ? { ...record(preferDesktop ? direct : desktop), ...record(preferDesktop ? desktop : direct) }
      : Object.hasOwn(entries, preferDesktop ? "codex-desktop" : "codex")
        ? entries[preferDesktop ? "codex-desktop" : "codex"]
        : entries[preferDesktop ? "codex" : "codex-desktop"];
    // The old key remains as recovery data; only the unified key is presented.
    patch[key] = { ...entries, codex: value };
  }
  if (preferDesktop) patch.defaultEngine = "codex";
  const roles = settings["orchestration.roleMapping"];
  if (Array.isArray(roles)) patch["orchestration.roleMapping"] = roles.map(role => {
    const entry = record(role);
    return entry.engineType === "codex-desktop" ? { ...entry, engineType: "codex" } : role;
  });
  return patch;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
