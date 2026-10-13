import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CodexCatalogEnrollment {
  sourceId: string;
  cutoffMs: number;
}

/** Keep the opt-in boundary across upgrades without migrating old assignments. */
export function getOrCreateCodexCatalogEnrollment(
  userDataDirectory: string,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  now = Date.now(),
): CodexCatalogEnrollment {
  const home = existsSync(codexHome) ? realpathSync(codexHome) : resolve(codexHome);
  const sourceId = `codex-desktop:local:${createHash("sha256").update(home).digest("hex").slice(0, 20)}`;
  const file = join(userDataDirectory, "codex-desktop-catalog.json");
  const state = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; sources?: unknown }
    : { version: 1, sources: {} };
  if (state.version !== 1 || !state.sources || typeof state.sources !== "object" || Array.isArray(state.sources)) {
    throw new Error("The saved Codex catalog enrollment is invalid; existing history was not enrolled.");
  }
  const sources = state.sources as Record<string, { cutoffMs?: unknown }>;
  if (Object.hasOwn(sources, sourceId)) {
    const cutoffMs = sources[sourceId]?.cutoffMs;
    if (typeof cutoffMs !== "number" || !Number.isSafeInteger(cutoffMs) || cutoffMs <= 0 || cutoffMs % 1000 !== 0) {
      throw new Error("The saved Codex catalog cutoff is invalid; existing history was not enrolled.");
    }
    return { sourceId, cutoffMs };
  }
  if (!Number.isFinite(now) || now < 1000) throw new Error("A valid enrollment time is required.");
  const cutoffMs = Math.floor(now / 1000) * 1000;
  sources[sourceId] = { cutoffMs };
  mkdirSync(userDataDirectory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  return { sourceId, cutoffMs };
}
