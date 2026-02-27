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

// --- Copilot CLI tool name mapping (via @github/copilot-sdk) ---

const COPILOT_TOOL_MAP: Record<string, NormalizedToolName> = {
  // Shell
  powershell: "shell", bash: "shell", shell: "shell",
  read_powershell: "shell", write_powershell: "shell", stop_powershell: "shell",
  // File operations
  view: "read", read_file: "read",
  create: "write", write_file: "write",
  edit: "edit", edit_file: "edit",
  // Search
  grep: "grep", search: "grep",
  glob: "glob", find: "glob",
  list: "list",
  // Web
  web_fetch: "web_fetch", fetch_url: "web_fetch", web_search: "web_fetch",
  // Agent
  task: "task",
  // Todo
  update_todo: "todo",
  // Intent (Copilot-specific, not a real tool)
  report_intent: "unknown",
};

const ENGINE_TOOL_MAPS: Partial<Record<EngineType, Record<string, NormalizedToolName>>> = {
  opencode: OPENCODE_TOOL_MAP,
  claude: CLAUDE_TOOL_MAP,
  copilot: COPILOT_TOOL_MAP,
};

/**
 * Normalize a tool name from any engine that provides explicit tool name strings.
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
 * Infer the operation kind from a kind hint or the normalized tool name.
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
