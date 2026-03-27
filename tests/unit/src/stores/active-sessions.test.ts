import { describe, it, expect } from 'vitest';
import type { SessionActivityStatus } from '../../../../src/types/unified';

/**
 * Pure logic extracted from Chat.tsx activeSessions computation.
 * Given a list of session IDs, pinned set, delaying set, and a status getter,
 * returns the IDs that should appear in the Active section.
 */
function computeActiveSessions(
  sessionIds: string[],
  pinnedSessions: Set<string>,
  delayingRemoval: Set<string>,
  getSessionStatus: (sid: string) => SessionActivityStatus,
): string[] {
  return sessionIds.filter((sid) => {
    if (pinnedSessions.has(sid)) return true;
    if (delayingRemoval.has(sid)) return true;
    return getSessionStatus(sid) !== "idle";
  });
}

describe('Active Sessions filtering', () => {
  const statuses: Record<string, SessionActivityStatus> = {
    "s1": "idle",
    "s2": "running",
    "s3": "completed",
    "s4": "waiting",
    "s5": "error",
    "s6": "cancelled",
    "s7": "idle",
  };
  const getStatus = (sid: string): SessionActivityStatus => statuses[sid] ?? "idle";
  const allIds = Object.keys(statuses);

  it('includes only non-idle sessions when no pins or delays', () => {
    const result = computeActiveSessions(allIds, new Set(), new Set(), getStatus);
    expect(result).toEqual(["s2", "s3", "s4", "s5", "s6"]);
  });

  it('includes pinned sessions even if idle', () => {
    const pinned = new Set(["s1", "s7"]);
    const result = computeActiveSessions(allIds, pinned, new Set(), getStatus);
    expect(result).toContain("s1");
    expect(result).toContain("s7");
    expect(result).toContain("s2"); // running — still included
  });

  it('includes delaying sessions even if idle', () => {
    const delaying = new Set(["s1"]);
    const result = computeActiveSessions(allIds, new Set(), delaying, getStatus);
    expect(result).toContain("s1");
  });

  it('pinned takes priority — idle session stays if pinned', () => {
    const pinned = new Set(["s1"]);
    const result = computeActiveSessions(allIds, pinned, new Set(), getStatus);
    expect(result).toContain("s1");
  });

  it('unpin removes idle session from active', () => {
    // Before unpin
    const pinned = new Set(["s1"]);
    const before = computeActiveSessions(allIds, pinned, new Set(), getStatus);
    expect(before).toContain("s1");

    // After unpin (remove from pinned set)
    const unpinned = new Set<string>();
    const after = computeActiveSessions(allIds, unpinned, new Set(), getStatus);
    expect(after).not.toContain("s1");
  });

  it('unpin keeps running session in active (auto rule)', () => {
    // s2 is running — even without pin, it stays
    const pinned = new Set(["s2"]);
    const before = computeActiveSessions(allIds, pinned, new Set(), getStatus);
    expect(before).toContain("s2");

    const unpinned = new Set<string>();
    const after = computeActiveSessions(allIds, unpinned, new Set(), getStatus);
    expect(after).toContain("s2"); // still there because running
  });

  it('empty session list returns empty', () => {
    const result = computeActiveSessions([], new Set(["s1"]), new Set(), getStatus);
    expect(result).toEqual([]);
  });

  it('all idle sessions returns empty with no pins', () => {
    const allIdle = (sid: string): SessionActivityStatus => "idle";
    const result = computeActiveSessions(allIds, new Set(), new Set(), allIdle);
    expect(result).toEqual([]);
  });
});

describe('Active Sessions delayed removal lifecycle', () => {
  it('session remains during delay period', () => {
    // s1 is idle but in delayingRemoval — should be included
    const getStatus = (): SessionActivityStatus => "idle";
    const delaying = new Set(["s1"]);
    const result = computeActiveSessions(["s1"], new Set(), delaying, getStatus);
    expect(result).toContain("s1");
  });

  it('session removed after delay period', () => {
    const getStatus = (): SessionActivityStatus => "idle";
    const delaying = new Set<string>(); // delay expired
    const result = computeActiveSessions(["s1"], new Set(), delaying, getStatus);
    expect(result).not.toContain("s1");
  });

  it('unpin cancels delay and removes immediately', () => {
    const getStatus = (): SessionActivityStatus => "idle";
    // Before: pinned + delaying
    const r1 = computeActiveSessions(["s1"], new Set(["s1"]), new Set(["s1"]), getStatus);
    expect(r1).toContain("s1");

    // After unpin: remove from both pinned and delaying
    const r2 = computeActiveSessions(["s1"], new Set(), new Set(), getStatus);
    expect(r2).not.toContain("s1");
  });
});

describe('Active Sessions search filtering', () => {
  interface MockSession { id: string; title: string }

  function filterBySearch(sessions: MockSession[], query: string): MockSession[] {
    if (!query.trim()) return sessions;
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => (s.title || "").toLowerCase().includes(q));
  }

  const sessions: MockSession[] = [
    { id: "s1", title: "Fix authentication bug" },
    { id: "s2", title: "Add user dashboard" },
    { id: "s3", title: "Refactor API endpoints" },
  ];

  it('returns all sessions when query is empty', () => {
    expect(filterBySearch(sessions, "")).toEqual(sessions);
    expect(filterBySearch(sessions, "   ")).toEqual(sessions);
  });

  it('filters by title match', () => {
    const result = filterBySearch(sessions, "auth");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it('case insensitive search', () => {
    const result = filterBySearch(sessions, "API");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s3");
  });

  it('no matches returns empty', () => {
    expect(filterBySearch(sessions, "nonexistent")).toEqual([]);
  });
});
