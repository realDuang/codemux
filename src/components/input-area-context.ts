import type { UnifiedPermission, UnifiedQuestion } from "../types/unified";

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
