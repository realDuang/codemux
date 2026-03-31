import { describe, it, expect } from 'vitest';
import { computeActiveSessions, filterSessionsBySearch } from '../../../../src/lib/active-sessions';
import type { SessionActivityStatus } from '../../../../src/types/unified';

describe('Active Sessions filtering (computeActiveSessions)', () => {
  interface MockSession { id: string; engineType: string }

  const sessions: MockSession[] = [
    { id: "s1", engineType: "opencode" },
    { id: "s2", engineType: "copilot" },
    { id: "s3", engineType: "claude" },
    { id: "s4", engineType: "opencode" },
    { id: "s5", engineType: "copilot" },
    { id: "s6", engineType: "claude" },
    { id: "s7", engineType: "opencode" },
  ];

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
  const allEnabled = () => true;

  it('includes only non-idle sessions when no pins or delays', () => {
    const result = computeActiveSessions(sessions, new Set(), new Set(), getStatus, allEnabled);
    const ids = result.map(s => s.id);
    expect(ids).toEqual(["s2", "s3", "s4", "s5", "s6"]);
  });

  it('includes pinned sessions even if idle', () => {
    const pinned = new Set(["s1", "s7"]);
    const result = computeActiveSessions(sessions, pinned, new Set(), getStatus, allEnabled);
    const ids = result.map(s => s.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s7");
    expect(ids).toContain("s2"); // running — still included
  });

  it('includes delaying sessions even if idle', () => {
    const delaying = new Set(["s1"]);
    const result = computeActiveSessions(sessions, new Set(), delaying, getStatus, allEnabled);
    expect(result.map(s => s.id)).toContain("s1");
  });

  it('pinned takes priority — idle session stays if pinned', () => {
    const pinned = new Set(["s1"]);
    const result = computeActiveSessions(sessions, pinned, new Set(), getStatus, allEnabled);
    expect(result.map(s => s.id)).toContain("s1");
  });

  it('unpin removes idle session from active', () => {
    const pinned = new Set(["s1"]);
    const before = computeActiveSessions(sessions, pinned, new Set(), getStatus, allEnabled);
    expect(before.map(s => s.id)).toContain("s1");

    const unpinned = new Set<string>();
    const after = computeActiveSessions(sessions, unpinned, new Set(), getStatus, allEnabled);
    expect(after.map(s => s.id)).not.toContain("s1");
  });

  it('unpin keeps running session in active (auto rule)', () => {
    const pinned = new Set(["s2"]);
    const before = computeActiveSessions(sessions, pinned, new Set(), getStatus, allEnabled);
    expect(before.map(s => s.id)).toContain("s2");

    const unpinned = new Set<string>();
    const after = computeActiveSessions(sessions, unpinned, new Set(), getStatus, allEnabled);
    expect(after.map(s => s.id)).toContain("s2");
  });

  it('empty session list returns empty', () => {
    const result = computeActiveSessions([], new Set(["s1"]), new Set(), getStatus, allEnabled);
    expect(result).toEqual([]);
  });

  it('all idle sessions returns empty with no pins', () => {
    const allIdle = (): SessionActivityStatus => "idle";
    const result = computeActiveSessions(sessions, new Set(), new Set(), allIdle, allEnabled);
    expect(result).toEqual([]);
  });

  it('filters out sessions from disabled engines', () => {
    const isEnabled = (s: MockSession) => s.engineType !== "copilot";
    const result = computeActiveSessions(sessions, new Set(), new Set(), getStatus, isEnabled);
    const ids = result.map(s => s.id);
    expect(ids).not.toContain("s2"); // running but copilot disabled
    expect(ids).not.toContain("s5"); // error but copilot disabled
    expect(ids).toContain("s3"); // completed, claude enabled
  });
});

describe('Active Sessions delayed removal lifecycle', () => {
  interface MockSession { id: string }
  const allEnabled = () => true;

  it('session remains during delay period', () => {
    const getStatus = (): SessionActivityStatus => "idle";
    const sessions = [{ id: "s1" }];
    const delaying = new Set(["s1"]);
    const result = computeActiveSessions(sessions, new Set(), delaying, getStatus, allEnabled);
    expect(result.map(s => s.id)).toContain("s1");
  });

  it('session removed after delay period', () => {
    const getStatus = (): SessionActivityStatus => "idle";
    const sessions = [{ id: "s1" }];
    const delaying = new Set<string>();
    const result = computeActiveSessions(sessions, new Set(), delaying, getStatus, allEnabled);
    expect(result.map(s => s.id)).not.toContain("s1");
  });

  it('unpin cancels delay and removes immediately', () => {
    const getStatus = (): SessionActivityStatus => "idle";
    const sessions = [{ id: "s1" }];
    const r1 = computeActiveSessions(sessions, new Set(["s1"]), new Set(["s1"]), getStatus, allEnabled);
    expect(r1.map(s => s.id)).toContain("s1");

    const r2 = computeActiveSessions(sessions, new Set(), new Set(), getStatus, allEnabled);
    expect(r2.map(s => s.id)).not.toContain("s1");
  });
});

describe('Active Sessions search filtering (filterSessionsBySearch)', () => {
  const sessions = [
    { id: "s1", title: "Fix authentication bug" },
    { id: "s2", title: "Add user dashboard" },
    { id: "s3", title: "Refactor API endpoints" },
  ];

  it('returns all sessions when query is empty', () => {
    expect(filterSessionsBySearch(sessions, "")).toEqual(sessions);
    expect(filterSessionsBySearch(sessions, "   ")).toEqual(sessions);
  });

  it('filters by title match', () => {
    const result = filterSessionsBySearch(sessions, "auth");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it('case insensitive search', () => {
    const result = filterSessionsBySearch(sessions, "API");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s3");
  });

  it('no matches returns empty', () => {
    expect(filterSessionsBySearch(sessions, "nonexistent")).toEqual([]);
  });
});
