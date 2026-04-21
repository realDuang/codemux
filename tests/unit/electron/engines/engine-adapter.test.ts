// ============================================================================
// Unit Tests — EngineAdapter base class
// ============================================================================

import { describe, it, expect } from "vitest";
import { EngineAdapter } from "../../../../electron/main/engines/engine-adapter";

// Minimal concrete subclass that exposes the protected static filterPending
// and the default pending getter returns.
class TestAdapter extends EngineAdapter {
  getInfo() {
    return { type: "opencode" as const, name: "t", available: true };
  }
  async listModels() { return []; }
  async createSession() { return "" as any; }
  async listSessions() { return []; }
  async deleteSession() { /* noop */ }
  async sendMessage() { /* noop */ }
  async cancelMessage() { /* noop */ }
  async loadMessages() { return []; }
  async replyPermission() { /* noop */ }
  async replyQuestion() { /* noop */ }
  async rejectQuestion() { /* noop */ }
  async listProjects() { return []; }

  static callFilterPending<V, R>(
    map: Map<string, V>,
    sessionId: string | undefined,
    project: (v: V) => R,
    getSessionId: (v: V) => string | undefined,
  ): R[] {
    // @ts-expect-error -- exposing protected static for test
    return EngineAdapter.filterPending(map, sessionId, project, getSessionId);
  }
}

describe("EngineAdapter", () => {
  describe("default getPendingPermissions / getPendingQuestions", () => {
    it("returns empty arrays for engines without pending support", async () => {
      const a = new TestAdapter();
      expect(await a.getPendingPermissions()).toEqual([]);
      expect(await a.getPendingQuestions()).toEqual([]);
      expect(await a.getPendingPermissions("any")).toEqual([]);
      expect(await a.getPendingQuestions("any")).toEqual([]);
    });
  });

  describe("filterPending", () => {
    type Entry = { sessionId: string; payload: { id: string; label: string } };

    const build = () => {
      const m = new Map<string, Entry>();
      m.set("a", { sessionId: "s1", payload: { id: "a", label: "A" } });
      m.set("b", { sessionId: "s2", payload: { id: "b", label: "B" } });
      m.set("c", { sessionId: "s1", payload: { id: "c", label: "C" } });
      m.set("d", { sessionId: "", payload: { id: "d", label: "D" } });
      return m;
    };

    it("projects and filters entries matching the given sessionId", () => {
      const out = TestAdapter.callFilterPending(
        build(),
        "s1",
        (v) => v.payload,
        (v) => v.sessionId,
      );
      expect(out.map((p) => p.id).sort()).toEqual(["a", "c"]);
    });

    it("returns all entries when sessionId is undefined", () => {
      const out = TestAdapter.callFilterPending(
        build(),
        undefined,
        (v) => v.payload,
        (v) => v.sessionId,
      );
      expect(out).toHaveLength(4);
    });

    it("returns empty array when no entries match", () => {
      const out = TestAdapter.callFilterPending(
        build(),
        "does-not-exist",
        (v) => v.payload,
        (v) => v.sessionId,
      );
      expect(out).toEqual([]);
    });

    it("handles empty maps", () => {
      const out = TestAdapter.callFilterPending(
        new Map(),
        "s1",
        (v: any) => v,
        (v: any) => v.sessionId,
      );
      expect(out).toEqual([]);
    });

    it("applies the projection function to each emitted value", () => {
      const out = TestAdapter.callFilterPending(
        build(),
        "s1",
        (v) => v.payload.label.toLowerCase(),
        (v) => v.sessionId,
      );
      expect(out.sort()).toEqual(["a", "c"]);
    });

    it("skips entries whose getSessionId returns a different value even when sessionId is an empty string-ish match would otherwise be ambiguous", () => {
      // When sessionId is explicitly "s2", only the single s2 entry matches.
      const out = TestAdapter.callFilterPending(
        build(),
        "s2",
        (v) => v.payload.id,
        (v) => v.sessionId,
      );
      expect(out).toEqual(["b"]);
    });
  });
});
