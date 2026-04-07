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
  // SQL (used by Copilot for structured data including todo management)
  sql: "sql",
  // Intent (Copilot-specific, not a real tool)
  report_intent: "unknown",
};

// --- Codex tool name mapping (app-server ThreadItem types) ---

const CODEX_TOOL_MAP: Record<string, NormalizedToolName> = {
  command_execution: "shell",
  file_change: "edit",
  file_read: "read",
  code_execution: "shell",
  local_shell_command: "shell",
  mcp_tool_call: "unknown",
};

const ENGINE_TOOL_MAPS: Partial<Record<EngineType, Record<string, NormalizedToolName>>> = {
  opencode: OPENCODE_TOOL_MAP,
  claude: CLAUDE_TOOL_MAP,
  copilot: COPILOT_TOOL_MAP,
  codex: CODEX_TOOL_MAP,
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
    return normalizeToolNameWithMap(engineTool, map);
  }
  return "unknown";
}

/**
 * Normalize a tool name using the given mapping table.
 * Tries exact match first, then lowercase, then falls back to "unknown".
 */
export function normalizeToolNameWithMap(
  toolName: string,
  toolMap: Record<string, NormalizedToolName>,
): NormalizedToolName {
  return toolMap[toolName] ?? toolMap[toolName.toLowerCase()] ?? "unknown";
}

/**
 * Infer the operation kind from a kind hint or the normalized tool name.
 */
export function inferToolKind(
  sdkKind?: string,
  normalizedTool?: NormalizedToolName,
): "read" | "edit" | "other" {
  // SDK provides kind directly
  if (sdkKind === "read") return "read";
  if (sdkKind === "edit") return "edit";

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
