// =============================================================================
// Unit tests: Scroll Position Restore
//
// Validates the scroll position save/restore logic for Chat navigation and
// session switching. Tests the shared utility in src/lib/scroll-position.ts
// which is used by Chat.tsx.
//
// Scenarios covered:
//   1. Navigate Chat → Settings → Chat: restore saved position on remount
//   2. Switch Session A → B → A: restore A's saved position
//   3. First-time session view: no saved position → scroll to bottom
//   4. Save overwrites previous position on scroll
//   5. Cleanup on session delete prevents memory leak
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  saveScrollPosition,
  deleteScrollPosition,
  resolveRemountScroll,
  resolveSessionSwitchScroll,
} from "../../../../src/lib/scroll-position";

// ---------------------------------------------------------------------------
// Tests: Remount scroll restore (Chat → Settings → Chat)
// ---------------------------------------------------------------------------

describe("remount scroll restore (Chat → Settings → Chat)", () => {
  beforeEach(() => {
    // Clean up any state from previous tests
    deleteScrollPosition("session-1");
  });

  it("restores saved position after remount", () => {
    saveScrollPosition("session-1", 420);

    const result = resolveRemountScroll("session-1");
    expect(result).toEqual({ action: "restore", position: 420 });
  });

  it("does nothing when no position was saved", () => {
    const result = resolveRemountScroll("session-1");
    expect(result).toEqual({ action: "none" });
  });

  it("does nothing when there is no current session", () => {
    saveScrollPosition("session-1", 420);

    const result = resolveRemountScroll(null);
    expect(result).toEqual({ action: "none" });
  });

  it("restores the latest saved position after multiple scrolls", () => {
    saveScrollPosition("session-1", 100);
    saveScrollPosition("session-1", 200);
    saveScrollPosition("session-1", 350);

    const result = resolveRemountScroll("session-1");
    expect(result).toEqual({ action: "restore", position: 350 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Session switch scroll restore (Session A → B → A)
// ---------------------------------------------------------------------------

describe("session switch scroll restore", () => {
  beforeEach(() => {
    deleteScrollPosition("session-a");
    deleteScrollPosition("session-b");
    deleteScrollPosition("session-c");
  });

  it("restores saved position when switching back to a viewed session", () => {
    saveScrollPosition("session-a", 500);

    const result = resolveSessionSwitchScroll("session-a", true);
    expect(result).toEqual({ action: "restore", position: 500 });
  });

  it("scrolls to bottom for a session with no saved position", () => {
    const result = resolveSessionSwitchScroll("session-b", true);
    expect(result).toEqual({ action: "scrollToBottom" });
  });

  it("returns none when session has no existing messages", () => {
    saveScrollPosition("session-a", 500);

    const result = resolveSessionSwitchScroll("session-a", false);
    expect(result).toEqual({ action: "none" });
  });

  it("each session maintains its own independent scroll position", () => {
    saveScrollPosition("session-a", 100);
    saveScrollPosition("session-b", 800);
    saveScrollPosition("session-c", 0);

    expect(resolveSessionSwitchScroll("session-a", true))
      .toEqual({ action: "restore", position: 100 });
    expect(resolveSessionSwitchScroll("session-b", true))
      .toEqual({ action: "restore", position: 800 });
    expect(resolveSessionSwitchScroll("session-c", true))
      .toEqual({ action: "restore", position: 0 });
  });

  it("saves outgoing session position before switch", () => {
    saveScrollPosition("session-a", 300);

    const result = resolveSessionSwitchScroll("session-a", true);
    expect(result).toEqual({ action: "restore", position: 300 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Position persistence and cleanup
// ---------------------------------------------------------------------------

describe("scroll position cache persistence", () => {
  beforeEach(() => {
    deleteScrollPosition("session-1");
  });

  it("module-level state survives across calls (simulated mount/unmount)", () => {
    // Mount 1: user scrolls
    saveScrollPosition("session-1", 250);

    // Unmount (navigate to Settings) — state is NOT cleared

    // Mount 2: check position is still there
    expect(resolveRemountScroll("session-1")).toEqual({ action: "restore", position: 250 });

    // Mount 2: user scrolls further
    saveScrollPosition("session-1", 600);

    // Mount 3: latest position preserved
    expect(resolveRemountScroll("session-1")).toEqual({ action: "restore", position: 600 });
  });

  it("scroll position at 0 is a valid saved position", () => {
    saveScrollPosition("session-1", 0);

    // scrollTop=0 means user is at the top — should restore to top, not scroll to bottom
    const result = resolveSessionSwitchScroll("session-1", true);
    expect(result).toEqual({ action: "restore", position: 0 });
  });

  it("deleteScrollPosition removes saved position (no memory leak on session delete)", () => {
    saveScrollPosition("session-1", 420);
    expect(resolveRemountScroll("session-1")).toEqual({ action: "restore", position: 420 });

    deleteScrollPosition("session-1");
    expect(resolveRemountScroll("session-1")).toEqual({ action: "none" });
    expect(resolveSessionSwitchScroll("session-1", true)).toEqual({ action: "scrollToBottom" });
  });
});
