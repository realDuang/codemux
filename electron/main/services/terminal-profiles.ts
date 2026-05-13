// ============================================================================
// Terminal Shell Profile Detection
//
// Discovers shell profiles available on the host (PowerShell / pwsh / cmd /
// Git Bash / WSL distros on Windows; entries from /etc/shells on Unix) plus
// any user-defined profiles from settings.json. Modelled after VS Code's
// terminal profile system but trimmed to essentials.
//
// Profiles drive the "+" dropdown in TerminalPanel and the dropdown in
// Settings. The active default is the one used by `terminal.create` when no
// `profileId` is given.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { loadSettings } from "./logger";
import type { TerminalProfile } from "../../../src/types/unified";

interface CachedProfiles {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CachedProfiles | null = null;

function isExecutableFile(p: string): boolean {
  try {
    const s = fs.statSync(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Read a string array of all `programFiles*` env vars (handles 32/64-bit). */
function programFilesDirs(): string[] {
  const seen = new Set<string>();
  for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const v = process.env[key];
    if (v && !seen.has(v)) seen.add(v);
  }
  return [...seen];
}

function detectWindowsProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const seenKeys = new Set<string>();
  const push = (profile: TerminalProfile) => {
    // Dedup by (path, args) — WSL distros share `wsl.exe` but pass distinct
    // `-d <distro>` args, so the key must include args.
    const key = `${profile.path.toLowerCase()}::${(profile.args ?? []).join("\u0000")}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    profiles.push(profile);
  };

  // Windows PowerShell (always present on Windows ≥ 7)
  const psPath =
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : null;
  if (psPath && isExecutableFile(psPath)) {
    push({ id: "powershell", name: "Windows PowerShell", path: psPath, icon: "powershell" });
  }

  // PowerShell 7+ (`pwsh.exe`) — installed under Program Files\PowerShell\<n>\
  for (const root of programFilesDirs()) {
    const pwshRoot = path.join(root, "PowerShell");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pwshRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(pwshRoot, entry.name, "pwsh.exe");
      if (isExecutableFile(candidate)) {
        push({
          id: `pwsh-${entry.name}`,
          name: `PowerShell ${entry.name}`,
          path: candidate,
          icon: "powershell",
        });
      }
    }
  }

  // cmd.exe
  const cmd =
    process.env.ComSpec ||
    (process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : null);
  if (cmd && isExecutableFile(cmd)) {
    push({ id: "cmd", name: "Command Prompt", path: cmd, icon: "terminal-cmd" });
  }

  // Git Bash — try both default install locations (32/64-bit).
  for (const root of programFilesDirs()) {
    const candidate = path.join(root, "Git", "bin", "bash.exe");
    if (isExecutableFile(candidate)) {
      push({
        id: "git-bash",
        name: "Git Bash",
        path: candidate,
        args: ["--login", "-i"],
        icon: "terminal-bash",
      });
      break;
    }
  }

  // WSL distros (best-effort; suppress all errors so a missing wsl.exe doesn't
  // poison detection on machines without WSL).
  const wslPath = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "wsl.exe")
    : null;
  if (wslPath && isExecutableFile(wslPath)) {
    let raw = "";
    try {
      raw = execFileSync(wslPath, ["-l", "-q"], {
        encoding: "utf16le",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // ignore — WSL may be installed but no distros, or the call may hang.
    }
    const distros = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\u0000/g, "").trim())
      .filter((line) => line.length > 0);
    for (const distro of distros) {
      push({
        id: `wsl-${distro.toLowerCase()}`,
        name: `WSL: ${distro}`,
        path: wslPath,
        args: ["-d", distro],
        icon: "terminal-linux",
      });
    }
  }

  return profiles;
}

function detectUnixProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const seen = new Set<string>();
  const add = (shellPath: string, displayName?: string) => {
    if (seen.has(shellPath) || !isExecutableFile(shellPath)) return;
    seen.add(shellPath);
    const name = displayName ?? path.basename(shellPath);
    profiles.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      path: shellPath,
    });
  };

  // Inherit the user's preferred shell first.
  if (process.env.SHELL) add(process.env.SHELL);

  // /etc/shells lists vetted login shells; filter to existing executables.
  try {
    const list = fs
      .readFileSync("/etc/shells", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const candidate of list) add(candidate);
  } catch {
    // /etc/shells absent; fall through to common defaults.
  }

  for (const fallback of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    add(fallback);
  }

  return profiles;
}

function loadCustomProfiles(): TerminalProfile[] {
  const settings = loadSettings();
  const raw = (settings as Record<string, unknown>).terminal as
    | { customProfiles?: unknown }
    | undefined;
  const list = raw?.customProfiles;
  if (!Array.isArray(list)) return [];
  const out: TerminalProfile[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const idRaw = typeof obj.id === "string" ? obj.id : null;
    const nameRaw = typeof obj.name === "string" ? obj.name : null;
    const pathRaw = typeof obj.path === "string" ? obj.path : null;
    if (!idRaw || !nameRaw || !pathRaw) continue;
    out.push({
      id: idRaw,
      name: nameRaw,
      path: pathRaw,
      args: Array.isArray(obj.args) ? (obj.args.filter((a) => typeof a === "string") as string[]) : undefined,
      env:
        obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)
          ? Object.fromEntries(
              Object.entries(obj.env as Record<string, unknown>).filter(
                ([, v]) => typeof v === "string",
              ),
            ) as Record<string, string>
          : undefined,
      icon: typeof obj.icon === "string" ? obj.icon : undefined,
      custom: true,
    });
  }
  return out;
}

function pickDefaultProfileId(profiles: TerminalProfile[]): string | null {
  const settings = loadSettings();
  const raw = (settings as Record<string, unknown>).terminal as
    | { defaultProfile?: unknown }
    | undefined;
  const desired = typeof raw?.defaultProfile === "string" ? raw.defaultProfile : null;
  if (desired && profiles.some((p) => p.id === desired)) return desired;

  // Heuristic: prefer pwsh/PowerShell on Windows, the user's $SHELL on Unix.
  if (process.platform === "win32") {
    const pwsh = profiles.find((p) => p.id.startsWith("pwsh-"));
    if (pwsh) return pwsh.id;
    const ps = profiles.find((p) => p.id === "powershell");
    if (ps) return ps.id;
    return profiles[0]?.id ?? null;
  }
  if (process.env.SHELL) {
    const m = profiles.find((p) => p.path === process.env.SHELL);
    if (m) return m.id;
  }
  return profiles[0]?.id ?? null;
}

/**
 * Return the (possibly cached) list of available profiles plus the resolved
 * default ID. Pass `{ refresh: true }` to bypass the cache.
 */
export function listTerminalProfiles(options?: { refresh?: boolean }): {
  profiles: TerminalProfile[];
  defaultProfileId: string | null;
} {
  if (cache && !options?.refresh && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    // Custom profiles & default may change in settings.json without our cache
    // invalidating, so re-resolve those bits cheaply on every call.
    const profiles = [...cache.profiles.filter((p) => !p.custom), ...loadCustomProfiles()];
    return { profiles, defaultProfileId: pickDefaultProfileId(profiles) };
  }

  const detected =
    process.platform === "win32" ? detectWindowsProfiles() : detectUnixProfiles();
  const profiles = [...detected, ...loadCustomProfiles()];
  const defaultProfileId = pickDefaultProfileId(profiles);
  cache = { profiles: detected, defaultProfileId, fetchedAt: Date.now() };
  return { profiles, defaultProfileId };
}

/** Resolve a profile ID to its full record, or `null` if unknown. */
export function getTerminalProfile(id: string | undefined | null): TerminalProfile | null {
  if (!id) return null;
  const { profiles } = listTerminalProfiles();
  return profiles.find((p) => p.id === id) ?? null;
}

/** Reset the in-memory cache. Used by tests and after settings updates. */
export function _resetTerminalProfileCache(): void {
  cache = null;
}
