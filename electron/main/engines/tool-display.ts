// ============================================================================
// Tool display normalization (engine-agnostic)
//
// The renderer shows every engine's tool calls as compact activity rows
// ("Read src/app.ts", "Ran npm test", "Searched src for “TODO”"). Those rows
// are driven by `ToolPart.displayActions`. Adapters with richer native data
// (e.g. Codex parsing shell commands into read/search actions) set it
// themselves; for everything else this module derives it from the normalized
// tool name and the canonical tool input, so the frontend never needs to know
// which engine produced a part.
// ============================================================================

import type { ToolDisplayAction, ToolPart, UnifiedMessage, UnifiedPart } from "../../../src/types/unified";

type Input = Record<string, unknown>;

function asRecord(value: unknown): Input {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Input : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function command(input: Input): string | undefined {
  const raw = input.command ?? input.cmd;
  if (Array.isArray(raw)) return text(raw.filter((item) => typeof item === "string").join(" "));
  return text(raw);
}

/** Show paths relative to the session directory when they live inside it. */
export function displayPath(path: string, workingDirectory?: string): string {
  if (!workingDirectory) return path;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalize(workingDirectory);
  const target = normalize(path);
  if (!base || target === base) return path;
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : path;
}

/**
 * Derive display actions from a tool part's canonical input. Accepts the key
 * variants adapters emit today (`filePath` / `file_path` / `path`,
 * `command` / `cmd`, `pattern` / `query`, `url`).
 */
export function deriveToolDisplayActions(part: ToolPart, workingDirectory?: string): ToolDisplayAction[] | undefined {
  const input = asRecord(part.state?.input);
  const path = (...values: unknown[]) => {
    const value = text(...values);
    return value ? displayPath(value, workingDirectory) : undefined;
  };

  switch (part.normalizedTool) {
    case "read": {
      const target = path(input.filePath, input.file_path, input.path, input.absolutePath, part.locations?.[0]?.path);
      return target ? [{ kind: "read", path: target }] : undefined;
    }
    case "list": {
      const target = path(input.path, input.dirPath, input.directory, input.filePath, input.file_path) ?? ".";
      return [{ kind: "list", path: target }];
    }
    case "grep":
    case "glob": {
      const query = text(input.pattern, input.query, input.regex, input.glob);
      if (!query) return undefined;
      const target = path(input.path, input.directory, input.cwd);
      return [target ? { kind: "search", query, path: target } : { kind: "search", query }];
    }
    case "shell": {
      const value = command(input);
      return value ? [{ kind: "shell", command: value }] : undefined;
    }
    case "edit":
    case "write": {
      const targets = [
        path(input.filePath, input.file_path, input.path),
        ...(part.locations ?? []).map((location) => path(location.path)),
      ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);
      return targets.length > 0 ? targets.map((target) => ({ kind: "edit", path: target })) : undefined;
    }
    case "web_fetch": {
      const label = text(input.url, input.query);
      return label ? [{ kind: "web", label }] : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Fill engine-agnostic presentation fields on a tool part. Native
 * `displayActions` and `diff` set by an adapter always win.
 */
export function normalizeToolPartDisplay<T extends UnifiedPart>(part: T, workingDirectory?: string): T {
  if (part.type !== "tool") return part;
  const tool = part as ToolPart;
  let next: ToolPart | undefined;

  if (!tool.displayActions?.length) {
    const actions = deriveToolDisplayActions(tool, workingDirectory);
    if (actions) next = { ...tool, displayActions: actions };
  }

  if (!tool.diff) {
    const metadata = tool.state && "metadata" in tool.state ? asRecord(tool.state.metadata) : {};
    const diff = text(metadata.diff);
    if (diff) next = { ...(next ?? tool), diff };
  }

  return (next ?? part) as T;
}

/** Apply {@link normalizeToolPartDisplay} to every part of a message. */
export function normalizeMessageToolDisplay<T extends UnifiedMessage>(message: T, workingDirectory?: string): T {
  if (!message.parts?.some((part) => part.type === "tool")) return message;
  const dir = workingDirectory ?? message.workingDirectory;
  return { ...message, parts: message.parts.map((part) => normalizeToolPartDisplay(part, dir)) };
}
