import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationMeta, EngineType } from "../../../../src/types/unified";

export interface CodexConversationMigrationOptions {
  /** Existing catalog enrollment identity; its spelling survives the engine rename. */
  sourceId: string;
  /** Home used by legacy unscoped Codex sessions on this installation. */
  codexHome: string;
}

export function canonicalCodexEngineType(engineType: EngineType): EngineType {
  return engineType === "codex-desktop" ? "codex" : engineType;
}

export function canonicalCodexThreadId(id: string): string {
  const nativeId = id.startsWith("codex_") ? id.slice("codex_".length) : id;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId) ? nativeId : id;
}

export function canonicalCodexProjectId(id: string): string {
  return id.startsWith("catalog:codex-desktop:") ? `catalog:codex:${id.slice("catalog:codex-desktop:".length)}` : id;
}

/** A native UUID is only unique inside its original Codex home. */
export function codexConversationIdentity(conversation: ConversationMeta, options: CodexConversationMigrationOptions): string | undefined {
  if (canonicalCodexEngineType(conversation.engineType) !== "codex" || !conversation.engineSessionId) return undefined;
  const threadId = canonicalCodexThreadId(conversation.engineSessionId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) return undefined;
  return JSON.stringify([codexConversationSource(conversation, options.sourceId), threadId]);
}

/** Resolve a legacy source without admitting it into the active native catalog. */
export function codexConversationSource(conversation: ConversationMeta, defaultSourceId: string): string {
  const explicitSource = conversation.catalogSourceId ?? conversation.engineMeta?.sourceId;
  if (typeof explicitSource === "string" && explicitSource) return explicitSource;
  const explicitHome = conversation.engineMeta?.codexHome;
  if (typeof explicitHome !== "string") return defaultSourceId;
  const canonicalHome = existsSync(explicitHome) ? realpathSync(explicitHome) : resolve(explicitHome);
  return `codex-desktop:local:${createHash("sha256").update(canonicalHome).digest("hex").slice(0, 20)}`;
}

/** Metadata migration does not grant catalog admission or native deletion rights. */
export function migrateCodexConversationMetadata(conversation: ConversationMeta): ConversationMeta {
  if (canonicalCodexEngineType(conversation.engineType) !== "codex") return conversation;
  const threadId = conversation.engineSessionId ? canonicalCodexThreadId(conversation.engineSessionId) : undefined;
  return {
    ...conversation,
    engineType: "codex",
    ...(conversation.engineType === "codex" ? {
      engineMeta: { ...conversation.engineMeta, codexDesktopOwner: conversation.engineMeta?.codexDesktopOwner ?? "codemux" },
    } : {}),
    ...(threadId !== undefined ? { engineSessionId: threadId } : {}),
    ...(typeof conversation.projectId === "string" ? { projectId: canonicalCodexProjectId(conversation.projectId) } : {}),
  };
}

function messageTurnId(message: { id: string }): string | undefined {
  const fields = message.id.split(":");
  if (fields[0] === "codex-desktop" && fields[1] === "v1") return fields[4];
  if (fields[0] === "msg_codex") return fields[2];
  return undefined;
}

/** Prefer one complete projection for an overlapping turn instead of duplicating replies. */
export function mergeCodexConversationHistory<T extends { id: string; parts: unknown[]; time: { created: number; completed?: number } }>(
  histories: readonly T[][],
): T[] {
  const turns = new Map<string, { messages: T[]; score: number; hasFinal: boolean }>();
  const unscoped = new Map<string, T>();
  for (const history of histories) {
    const grouped = new Map<string, T[]>();
    for (const message of history) {
      const turn = messageTurnId(message);
      if (turn) grouped.set(turn, [...(grouped.get(turn) ?? []), message]);
      else if (!unscoped.has(message.id)) unscoped.set(message.id, message);
    }
    for (const [turn, messages] of grouped) {
      // Native snapshots may use different message boundaries. A completed
      // answer beats a larger partial snapshot; originals remain in backup.
      const hasFinal = messages.some(message => message.parts.some(part => typeof part === "object" && part !== null
        && "type" in part && part.type === "text" && "phase" in part && part.phase === "final"
        && (("text" in part && typeof part.text === "string" && part.text.trim().length > 0)
          || ("inlineAssets" in part && Array.isArray(part.inlineAssets) && part.inlineAssets.length > 0))));
      const score = JSON.stringify(messages.map(message => message.parts)).length;
      const previous = turns.get(turn);
      if (!previous || Number(hasFinal) > Number(previous.hasFinal)
        || (hasFinal === previous.hasFinal && score > previous.score)) turns.set(turn, { messages, score, hasFinal });
    }
  }
  const messages = [...unscoped.values(), ...[...turns.values()].flatMap(turn => turn.messages)];
  return [...new Map(messages.map(message => [message.id, message])).values()].sort((left, right) => left.time.created - right.time.created);
}
