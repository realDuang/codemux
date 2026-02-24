// ============================================================================
// Tool Name Normalization & Inference
// Maps engine-specific tool names to normalized names for renderer dispatch.
// ============================================================================

import type { EngineType, NormalizedToolName } from "./unified";

// --- OpenCode tool name mapping ---

const OPENCODE_TOOL_MAP: Record<string, NormalizedToolName> = {
  bash: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  list: "list",
  webfetch: "web_fetch",
  task: "task",
  todowrite: "todo",
  todoread: "todo",
};

// --- Claude Code tool name mapping ---

const CLAUDE_TOOL_MAP: Record<string, NormalizedToolName> = {
  Bash: "shell",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "web_fetch",
  Task: "task",
  TodoWrite: "todo",
};

const ENGINE_TOOL_MAPS: Partial<Record<EngineType, Record<string, NormalizedToolName>>> = {
  opencode: OPENCODE_TOOL_MAP,
  claude: CLAUDE_TOOL_MAP,
};

/**
 * Normalize a tool name from OpenCode or Claude Code (engines that provide
 * explicit tool name strings).
 */
export function normalizeToolName(
  engineType: EngineType,
  engineTool: string,
): NormalizedToolName {
  const map = ENGINE_TOOL_MAPS[engineType];
  if (map) {
    const normalized = map[engineTool] ?? map[engineTool.toLowerCase()];
    if (normalized) return normalized;
  }
  return "unknown";
}

/**
 * Infer a normalized tool name from ACP's rawInput structure and title.
 * Used for Copilot CLI and other ACP engines that don't provide explicit
 * tool name fields.
 */
export function inferToolFromAcp(
  title: string,
  rawInput: unknown,
): NormalizedToolName {
  if (!rawInput || typeof rawInput !== "object") return "unknown";
  const input = rawInput as Record<string, unknown>;

  // Shell: has "command" field
  if ("command" in input) return "shell";

  // Glob: has "pattern" and "path", title starts with "Finding files"
  if ("pattern" in input && "path" in input && !("view_range" in input)) {
    return "glob";
  }

  // Read/View: has "path" + "view_range", or title starts with "Viewing"
  if ("view_range" in input) return "read";
  if (title.startsWith("Viewing")) return "read";

  // Write/Create: has "path" + "file_text", or title starts with "Creating"
  if ("file_text" in input) return "write";
  if (title.startsWith("Creating")) return "write";

  // Edit: has "path" + ("old_string" or "new_string" or "insert_line")
  if ("old_string" in input || "new_string" in input || "insert_line" in input) {
    return "edit";
  }

  // Grep: has "pattern" + "path", title contains "Searching" or "Search"
  if ("pattern" in input && (title.includes("Searching") || title.includes("Search"))) {
    return "grep";
  }

  // Web fetch: has "url"
  if ("url" in input) return "web_fetch";

  // Task/Agent: has "prompt" with subagent-like fields
  if ("prompt" in input && ("subagent_type" in input || "description" in input)) {
    return "task";
  }

  // Todo: has "todos" array
  if ("todos" in input && Array.isArray(input.todos)) return "todo";

  // SQL: has "query" or "sql"
  if ("query" in input && title.toLowerCase().includes("sql")) return "sql";

  return "unknown";
}

/**
 * Infer the operation kind from ACP's tool_call kind field or from
 * the normalized tool name.
 */
export function inferToolKind(
  acpKind?: string,
  normalizedTool?: NormalizedToolName,
): "read" | "edit" | "other" {
  // ACP provides kind directly
  if (acpKind === "read") return "read";
  if (acpKind === "edit") return "edit";

  // Fallback: infer from normalized tool name
  if (normalizedTool) {
    switch (normalizedTool) {
      case "read":
      case "grep":
      case "glob":
      case "list":
      case "web_fetch":
        return "read";
      case "write":
      case "edit":
        return "edit";
      case "shell":
      case "task":
        return "other";
      default:
        return "other";
    }
  }

  return "other";
}

/**
 * Get a display label for a normalized tool name.
 */
export function getToolDisplayName(normalizedTool: NormalizedToolName): string {
  switch (normalizedTool) {
    case "shell":
      return "Shell";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "grep":
      return "Search";
    case "glob":
      return "Find Files";
    case "list":
      return "List";
    case "web_fetch":
      return "Web Fetch";
    case "task":
      return "Agent Task";
    case "todo":
      return "Todo";
    case "sql":
      return "SQL";
    case "unknown":
      return "Tool";
  }
}
