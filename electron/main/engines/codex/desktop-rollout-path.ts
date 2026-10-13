import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, sep } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Checks storage evidence for an already admitted thread, without reading its rollout. */
export async function verifyCodexRolloutPath(
  threadId: string,
  metadata: Record<string, unknown>,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<"active" | "archived" | undefined> {
  const path = metadata.path;
  if (threadId.length !== 36 || !UUID.test(threadId) || metadata.id !== threadId
    || typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)
    || path.slice(parse(path).root.length).split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    || rolloutDate(basename(path), threadId) == null
    || !codexHome || codexHome.includes("\0")) return undefined;

  try {
    const home = await realpath(codexHome);
    const file = await realpath(path);
    const parts = relative(home, file).split(sep);
    const date = rolloutDate(parts.at(-1) ?? "", threadId);
    if (date == null) return undefined;

    let location: "active" | "archived";
    if (parts.length === 5 && parts[0] === "sessions" && parts.slice(1, 4).join("-") === date) {
      location = "active";
    } else if (parts.length === 2 && parts[0] === "archived_sessions") {
      location = "archived";
    } else {
      return undefined;
    }
    // lstat rejects a final symlink introduced after realpath resolved the file.
    return (await lstat(file)).isFile() ? location : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw error;
  }
}

function rolloutDate(filename: string, threadId: string): string | undefined {
  const match = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/.exec(filename);
  if (!match || match[0] !== filename || match[5] !== threadId || match[1].startsWith("0000-")) return undefined;
  const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
  const instant = new Date(timestamp);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === timestamp ? match[1] : undefined;
}
