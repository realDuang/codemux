import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyCodexRolloutPath } from "./desktop-rollout-path";

const MAX_METADATA_BYTES = 1024 * 1024;

export interface CodexRolloutMetadata {
  threadId: string;
  cliVersion?: string;
  originator?: string;
  source?: string;
}

export function normalizeCodexRuntimeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(value.trim())?.[1];
}

/** Open only native storage whose path and first record identify this thread. */
export async function openVerifiedCodexRollout(
  threadId: string,
  thread: Record<string, unknown>,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<{ file: FileHandle; metadata: CodexRolloutMetadata } | undefined> {
  let file: FileHandle | undefined;
  try {
    if (!await verifyCodexRolloutPath(threadId, thread, codexHome)) return undefined;
    const path = await realpath(String(thread.path));
    if (!await verifyCodexRolloutPath(threadId, { ...thread, path }, codexHome)) return undefined;
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (newline < 0 || newline >= bytesRead) return undefined;
    const entry = JSON.parse(buffer.toString("utf8", 0, newline)) as Record<string, unknown>;
    const payload = record(entry.payload);
    if (entry.type !== "session_meta" || payload.id !== threadId) return undefined;
    const result = { file, metadata: {
      threadId,
      cliVersion: normalizeCodexRuntimeVersion(payload.cli_version),
      originator: typeof payload.originator === "string" ? payload.originator : undefined,
      source: typeof payload.source === "string" ? payload.source : undefined,
    } };
    file = undefined;
    return result;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

export async function readCodexRolloutMetadata(
  threadId: string,
  thread: Record<string, unknown>,
  codexHome?: string,
): Promise<CodexRolloutMetadata | undefined> {
  const result = await openVerifiedCodexRollout(threadId, thread, codexHome);
  if (!result) return undefined;
  await result.file.close();
  return result.metadata;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
