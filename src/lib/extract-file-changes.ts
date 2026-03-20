/**
 * Extract file changes from session message parts.
 *
 * Scans ToolPart data for write/edit operations and returns a
 * deduplicated list of affected file paths with any available diff content.
 */

import type { UnifiedPart, ToolPart } from "../types/unified";

export interface ExtractedFileChange {
  path: string;
  status: "created" | "modified";
  /** Unified diff content (available for edit tools) */
  diff?: string;
  /** Full file content (available for write tools) */
  content?: string;
  /** File language extension (e.g. "ts", "py") */
  langExt?: string;
}

/**
 * Extract file changes from message parts.
 * Looks at ToolPart with normalizedTool "write" or "edit".
 * Merges multiple edits to the same file — keeps the last diff.
 */
export function extractFileChanges(
  allParts: UnifiedPart[],
): ExtractedFileChange[] {
  const fileMap = new Map<string, ExtractedFileChange>();

  for (const part of allParts) {
    if (part.type !== "tool") continue;
    const tool = part as ToolPart;

    if (tool.normalizedTool !== "write" && tool.normalizedTool !== "edit") {
      continue;
    }

    const filePath = resolveFilePath(tool);
    if (!filePath) continue;

    const ext = filePath.split(".").pop() ?? "";
    const diff = resolveDiff(tool);
    const content = resolveContent(tool);

    const existing = fileMap.get(filePath);
    if (!existing) {
      fileMap.set(filePath, {
        path: filePath,
        status: tool.normalizedTool === "write" ? "created" : "modified",
        diff,
        content,
        langExt: ext,
      });
    } else {
      // Later operations override earlier ones
      if (tool.normalizedTool === "edit") {
        existing.status = "modified";
      }
      if (diff) existing.diff = diff;
      if (content) existing.content = content;
    }
  }

  const result = Array.from(fileMap.values());
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function resolveFilePath(tool: ToolPart): string | undefined {
  // 1. Check state.input.filePath (OpenCode/Claude EditTool/WriteTool pattern)
  const state = tool.state as Record<string, unknown>;
  const input = state?.input as Record<string, unknown> | undefined;
  if (input?.filePath && typeof input.filePath === "string") {
    return input.filePath;
  }

  // 2. Check state.input.file_path or state.input.path (Copilot pattern)
  if (input?.file_path && typeof input.file_path === "string") {
    return input.file_path;
  }
  if (input?.path && typeof input.path === "string") {
    return input.path;
  }

  // 3. Check locations array
  if (tool.locations && tool.locations.length > 0) {
    return tool.locations[0].path;
  }

  return undefined;
}

/** Extract diff content from ToolPart. */
function resolveDiff(tool: ToolPart): string | undefined {
  // 1. ToolPart.diff (Copilot sets this from detailedContent)
  if (tool.diff) return tool.diff;

  // 2. state.metadata.diff (EditTool pattern)
  const state = tool.state as Record<string, unknown>;
  const metadata = state?.metadata as Record<string, unknown> | undefined;
  if (metadata?.diff && typeof metadata.diff === "string") {
    return metadata.diff;
  }

  return undefined;
}

/** Extract full file content for write tools. */
function resolveContent(tool: ToolPart): string | undefined {
  if (tool.normalizedTool !== "write") return undefined;
  const state = tool.state as Record<string, unknown>;
  const input = state?.input as Record<string, unknown> | undefined;
  if (input?.content && typeof input.content === "string") {
    return input.content;
  }
  return undefined;
}
