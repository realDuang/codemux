// =============================================================================
// Unit tests: Scroll Position Restore
//
// Validates the scroll position save/restore logic for Chat navigation and
// session switching. The module-level savedScrollPositions Map persists
// across component mount/unmount cycles.
//
// Scenarios covered:
//   1. Navigate Chat → Settings → Chat: restore saved position on remount
//   2. Switch Session A → B → A: restore A's saved position
//   3. First-time session view: no saved position → scroll to bottom
//   4. Save overwrites previous position on scroll
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — mirror the scroll position logic from Chat.tsx
// ---------------------------------------------------------------------------

type ScrollAction =
  | { action: "restore"; position: number }
  | { action: "scrollToBottom" }
  | { action: "loadFromDisk" }
  | { action: "none" };

/**
 * Decide scroll behavior when switching sessions (handleSelectSession).
 *
 * Mirrors Chat.tsx lines 941-953:
 * - No existing messages → load from disk (which scrolls to bottom internally)
 * - Has saved position → restore it
 * - No saved position → scroll to bottom
 */
function resolveSessionSwitchScroll(
  savedPositions: Map<string, number>,
  sessionId: string,
  hasExistingMessages: boolean,
): ScrollAction {
  if (!hasExistingMessages) {
    return { action: "loadFromDisk" };
  }
  const savedPos = savedPositions.get(sessionId);
  if (savedPos !== undefined) {
    return { action: "restore", position: savedPos };
  }
  return { action: "scrollToBottom" };
}

/**
 * Decide scroll behavior on component remount (initializeSession early return).
 *
 * Mirrors Chat.tsx lines 768-781:
 * - No current session → do nothing
 * - Has saved position → restore it
 * - No saved position → do nothing (DOM starts at 0, no data to restore)
 */
function resolveRemountScroll(
  savedPositions: Map<string, number>,
  currentSessionId: string | null,
): ScrollAction {
  if (!currentSessionId) return { action: "none" };
  const savedPos = savedPositions.get(currentSessionId);
  if (savedPos !== undefined) {
    return { action: "restore", position: savedPos };
  }
  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Tests: Remount scroll restore (Chat → Settings → Chat)
// ---------------------------------------------------------------------------

describe("remount scroll restore (Chat → Settings → Chat)", () => {
  let cache: Map<string, number>;

  beforeEach(() => {
    cache = new Map();
  });

  it("restores saved position after remount", () => {
    cache.set("session-1", 420);

    const result = resolveRemountScroll(cache, "session-1");
    expect(result).toEqual({ action: "restore", position: 420 });
  });

  it("does nothing when no position was saved", () => {
    const result = resolveRemountScroll(cache, "session-1");
    expect(result).toEqual({ action: "none" });
  });

  it("does nothing when there is no current session", () => {
    cache.set("session-1", 420);

    const result = resolveRemountScroll(cache, null);
    expect(result).toEqual({ action: "none" });
  });

  it("restores the latest saved position after multiple scrolls", () => {
    cache.set("session-1", 100);
    cache.set("session-1", 200);
    cache.set("session-1", 350);

    const result = resolveRemountScroll(cache, "session-1");
    expect(result).toEqual({ action: "restore", position: 350 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Session switch scroll restore (Session A → B → A)
// ---------------------------------------------------------------------------

describe("session switch scroll restore", () => {
  let cache: Map<string, number>;

  beforeEach(() => {
    cache = new Map();
  });

  it("restores saved position when switching back to a viewed session", () => {
    // User scrolls in session A
    cache.set("session-a", 500);

    // Switch to B, then back to A
    const result = resolveSessionSwitchScroll(cache, "session-a", true);
    expect(result).toEqual({ action: "restore", position: 500 });
  });

  it("scrolls to bottom for a session with no saved position", () => {
    const result = resolveSessionSwitchScroll(cache, "session-b", true);
    expect(result).toEqual({ action: "scrollToBottom" });
  });

  it("loads from disk when session has no existing messages", () => {
    cache.set("session-a", 500);

    const result = resolveSessionSwitchScroll(cache, "session-a", false);
    expect(result).toEqual({ action: "loadFromDisk" });
  });

  it("each session maintains its own independent scroll position", () => {
    cache.set("session-a", 100);
    cache.set("session-b", 800);
    cache.set("session-c", 0);

    expect(resolveSessionSwitchScroll(cache, "session-a", true))
      .toEqual({ action: "restore", position: 100 });
    expect(resolveSessionSwitchScroll(cache, "session-b", true))
      .toEqual({ action: "restore", position: 800 });
    expect(resolveSessionSwitchScroll(cache, "session-c", true))
      .toEqual({ action: "restore", position: 0 });
  });

  it("saves outgoing session position before switch", () => {
    // Simulate: user is at session-a scrollTop=300, switches to session-b
    const outgoingSessionId = "session-a";
    const outgoingScrollTop = 300;
    cache.set(outgoingSessionId, outgoingScrollTop);

    // Later, switch back to session-a
    const result = resolveSessionSwitchScroll(cache, "session-a", true);
    expect(result).toEqual({ action: "restore", position: 300 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Position persistence across mount/unmount cycles
// ---------------------------------------------------------------------------

describe("scroll position cache persistence", () => {
  it("module-level Map survives simulated mount/unmount cycles", () => {
    // The cache lives outside the component — simulate multiple lifecycles
    const cache = new Map<string, number>();

    // Mount 1: user scrolls
    cache.set("session-1", 250);

    // Unmount (navigate to Settings) — cache is NOT cleared

    // Mount 2: check position is still there
    expect(cache.get("session-1")).toBe(250);

    // Mount 2: user scrolls further
    cache.set("session-1", 600);

    // Unmount again

    // Mount 3: latest position preserved
    expect(cache.get("session-1")).toBe(600);
  });

  it("scroll position at 0 is a valid saved position", () => {
    const cache = new Map<string, number>();
    cache.set("session-1", 0);

    // scrollTop=0 means user is at the top — should restore to top, not scroll to bottom
    const result = resolveSessionSwitchScroll(cache, "session-1", true);
    expect(result).toEqual({ action: "restore", position: 0 });
  });
});
