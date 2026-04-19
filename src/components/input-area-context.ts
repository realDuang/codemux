import type { UnifiedPermission, UnifiedQuestion } from "../types/unified";

const PREVIEW_MAX_LINES = 8;
const PREVIEW_MAX_CHARS = 420;
const PATH_LIKE_KEYS = [
  "path",
  "paths",
  "file",
  "files",
  "filePath",
  "filePaths",
  "pattern",
  "patterns",
  "cwd",
  "directory",
  "grantRoot",
] as const;
const PREVIEW_OMIT_KEYS = new Set([
  "availableDecisions",
  "callId",
  "command",
  "commands",
  "cwd",
  "diff",
  "directory",
  "file",
  "fileChanges",
  "filePath",
  "filePaths",
  "files",
  "grantRoot",
  "itemId",
  "path",
  "paths",
  "pattern",
  "patterns",
  "toolCallId",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function appendStringValues(target: string[], value: unknown): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendStringValues(target, item);
    }
  }
}

function collectTargetsFromSource(source: unknown, target: string[]): void {
  const record = asRecord(source);
  if (!record) return;

  for (const key of PATH_LIKE_KEYS) {
    appendStringValues(target, record[key]);
  }

  const permissions = asRecord(record.permissions);
  const fileSystem = permissions ? asRecord(permissions.fileSystem) : null;
  if (fileSystem) {
    appendStringValues(target, fileSystem.read);
    appendStringValues(target, fileSystem.write);
  }

  const fileChanges = asRecord(record.fileChanges);
  if (fileChanges) {
    for (const path of Object.keys(fileChanges)) {
      if (path) {
        target.push(path);
      }
    }
  }
}

function formatCommandPreview(source: Record<string, unknown>): string | undefined {
  const command =
    typeof source.command === "string"
      ? source.command.trim()
      : Array.isArray(source.command)
        ? source.command.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ")
        : "";

  const args =
    typeof source.args === "string"
      ? source.args.trim()
      : Array.isArray(source.args)
        ? source.args.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ")
        : "";

  const combined = [command, args].filter(Boolean).join(" ").trim();
  if (combined) {
    return combined;
  }

  if (Array.isArray(source.commands)) {
    const commands = source.commands
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 3);
    if (commands.length > 0) {
      return commands.join("\n");
    }
  }

  return undefined;
}

function compactPreview(text: string, maxLines = PREVIEW_MAX_LINES, maxChars = PREVIEW_MAX_CHARS): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const hiddenLineCount = Math.max(0, lines.length - maxLines);
  let preview = lines.slice(0, maxLines).join("\n");

  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars).trimEnd()}…`;
  } else if (hiddenLineCount > 0) {
    preview = `${preview}\n…`;
  }

  return preview;
}

function buildRequestPreview(source: unknown): string | undefined {
  if (typeof source === "string") {
    return compactPreview(source);
  }

  if (Array.isArray(source)) {
    const values = source
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 3);
    return values.length > 0 ? compactPreview(values.join("\n")) : undefined;
  }

  const record = asRecord(source);
  if (!record) return undefined;

  const commandPreview = formatCommandPreview(record);
  if (commandPreview) {
    return compactPreview(commandPreview, 6, 240);
  }

  for (const key of ["reason", "prompt", "description", "input"] as const) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return compactPreview(record[key] as string, 5, 260);
    }
  }

  const sanitized = Object.fromEntries(
    Object.entries(record).filter(([key]) => !PREVIEW_OMIT_KEYS.has(key)),
  );
  if (Object.keys(sanitized).length === 0) {
    return undefined;
  }

  try {
    return compactPreview(JSON.stringify(sanitized, null, 2));
  } catch {
    return undefined;
  }
}

function uniqueTargets(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

export interface PermissionPreviewInfo {
  type: "diff" | "request";
  content: string;
}

export interface QuestionContextInfo {
  toolCallId?: string;
  isMultiQuestion: boolean;
  current: number;
  total: number;
}

export function getPermissionTargets(
  permission: Pick<UnifiedPermission, "patterns" | "rawInput" | "metadata">,
): string[] {
  const items: string[] = [];
  appendStringValues(items, permission.patterns);
  collectTargetsFromSource(permission.rawInput, items);
  collectTargetsFromSource(permission.metadata, items);
  return uniqueTargets(items);
}

export function getPermissionPreview(
  permission: Pick<UnifiedPermission, "diff" | "rawInput" | "metadata">,
): PermissionPreviewInfo | null {
  const diffPreview = typeof permission.diff === "string" ? compactPreview(permission.diff) : "";
  if (diffPreview) {
    return {
      type: "diff",
      content: diffPreview,
    };
  }

  const requestPreview = buildRequestPreview(permission.rawInput) ?? buildRequestPreview(permission.metadata);
  if (requestPreview) {
    return {
      type: "request",
      content: requestPreview,
    };
  }

  return null;
}

export function getQuestionContext(
  question: Pick<UnifiedQuestion, "toolCallId" | "questions">,
  pageIndex: number,
): QuestionContextInfo {
  return {
    toolCallId: question.toolCallId,
    isMultiQuestion: question.questions.length > 1,
    current: Math.min(pageIndex + 1, Math.max(question.questions.length, 1)),
    total: Math.max(question.questions.length, 1),
  };
}
