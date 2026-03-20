/**
 * Extract file changes from session message parts (non-git fallback).
 *
 * Scans ToolPart data for write/edit operations and returns a
 * deduplicated list of affected file paths.
 */

import type { UnifiedPart, ToolPart } from "../types/unified";

export interface ExtractedFileChange {
  path: string;
  status: "created" | "modified";
}

/**
 * Extract file change paths from message parts.
 * Looks at ToolPart with normalizedTool "write" or "edit" and their file metadata.
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

    // Extract file path from tool state metadata or locations
    const filePath = resolveFilePath(tool);
    if (!filePath) continue;

    // write = create (unless already tracked), edit = modify
    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, {
        path: filePath,
        status: tool.normalizedTool === "write" ? "created" : "modified",
      });
    } else if (tool.normalizedTool === "edit") {
      // If we see an edit after a write, it's still the same file
      fileMap.get(filePath)!.status = "modified";
    }
  }

  const result = Array.from(fileMap.values());
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function resolveFilePath(tool: ToolPart): string | undefined {
  // 1. Check locations array
  if (tool.locations && tool.locations.length > 0) {
    return tool.locations[0].path;
  }

  // 2. Check state metadata for filePath
  const state = tool.state as Record<string, unknown>;
  const metadata = state?.metadata as Record<string, unknown> | undefined;
  if (metadata?.filePath && typeof metadata.filePath === "string") {
    return metadata.filePath;
  }

  // 3. Check input for file_path or path
  const input = state?.input as Record<string, unknown> | undefined;
  if (input?.file_path && typeof input.file_path === "string") {
    return input.file_path;
  }
  if (input?.path && typeof input.path === "string") {
    return input.path;
  }

  return undefined;
}
