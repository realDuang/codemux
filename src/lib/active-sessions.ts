import type { SessionActivityStatus } from "../types/unified";

/**
 * Compute which sessions should appear in the Active section.
 * A session is active if:
 * 1. Its engine is enabled AND
 * 2. It is pinned, OR in delayed removal, OR its status is not "idle"
 */
export function computeActiveSessions<T extends { id: string }>(
  sessions: T[],
  pinnedSessions: Set<string>,
  delayingRemoval: Set<string>,
  getSessionStatus: (sid: string) => SessionActivityStatus,
  isEngineEnabled: (session: T) => boolean,
): T[] {
  return sessions.filter((s) => {
    if (!isEngineEnabled(s)) return false;
    if (pinnedSessions.has(s.id)) return true;
    if (delayingRemoval.has(s.id)) return true;
    return getSessionStatus(s.id) !== "idle";
  });
}

/**
 * Filter sessions by a search query matching against their title.
 */
export function filterSessionsBySearch<T extends { title?: string }>(
  sessions: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => (s.title || "").toLowerCase().includes(q));
}
