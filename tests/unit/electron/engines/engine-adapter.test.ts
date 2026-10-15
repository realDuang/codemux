// ============================================================================
// Unit Tests — EngineAdapter base class
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import { MockEngineAdapter } from "../../../../electron/main/engines/mock-adapter";

// Use the in-memory engine to exercise inherited defaults without a CLI or I/O.
class TestAdapter extends MockEngineAdapter {
  constructor(engineType = "opencode") {
    super({ engineType });
  }

  static callFilterPending<V, R>(
    map: Map<string, V>,
    sessionId: string | undefined,
    project: (v: V) => R,
    getSessionId: (v: V) => string | undefined,
  ): R[] {
    return this.filterPending(map, sessionId, project, getSessionId);
  }
}

describe("EngineAdapter", () => {
  describe("getSessionSharing", () => {
    it.each(["opencode", "copilot", "claude"])("does not advertise sharing for %s without an adapter implementation", (engineType) => {
      const adapter = new TestAdapter(engineType);
      expect(adapter.getSessionSharing()).toBeUndefined();
      expect(adapter.getInfo().capabilities.sessionSharing).toBeUndefined();
    });
  });

  describe("setSessionSharing", () => {
    it.each([true, false])("rejects the unsupported switch %s without changing existing sessions", async (enabled) => {
      const adapter = new TestAdapter();
      const session = await adapter.createSession("/existing-project");
      const before = structuredClone(session);
      const stopped = vi.spyOn(adapter, "stop");
      const removed = vi.spyOn(adapter, "deleteSession");
      const updated = vi.fn();
      adapter.on("session.updated", updated);

      await expect(adapter.setSessionSharing(enabled)).rejects.toThrow("This engine does not support session sharing.");

      expect(await adapter.getSession(session.id)).toEqual(before);
      expect(adapter.getSessionSharing()).toBeUndefined();
      expect(stopped).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(updated).not.toHaveBeenCalled();
    });
  });

  describe("assertSessionCompatible", () => {
    it("leaves source interpretation and native identity to the engine implementation", async () => {
      const adapter = new TestAdapter("claude");
      const session = await adapter.createSession("/existing-project");
      const meta = Object.freeze({ sourceId: "remote-provider", codexHome: "/unrelated-metadata", ccSessionId: "original-id" });

      expect(() => adapter.assertSessionCompatible(session.id, meta)).not.toThrow();
      expect(() => adapter.assertSessionCompatible(session.id)).not.toThrow();
      expect(meta).toEqual({ sourceId: "remote-provider", codexHome: "/unrelated-metadata", ccSessionId: "original-id" });
      expect(await adapter.getSession(session.id)).toBe(session);
    });
  });

  describe("restoreSession", () => {
    it("returns the original session without changing archive state or creating a replacement", async () => {
      const adapter = new TestAdapter();
      const session = await adapter.createSession("/original-project");
      session.archived = true;
      session.engineMeta = { nativeIdentity: "original" };
      const created = vi.spyOn(adapter, "createSession");

      const restored = await adapter.restoreSession(session.id, "/different-project", { nativeIdentity: "replacement" });

      expect(restored).toBe(session);
      expect(restored).toMatchObject({ directory: "/original-project", archived: true, engineMeta: { nativeIdentity: "original" } });
      expect(created).not.toHaveBeenCalled();
    });

    it("rejects a missing identity without silently creating another conversation", async () => {
      const adapter = new TestAdapter();
      const created = vi.spyOn(adapter, "createSession");

      await expect(adapter.restoreSession("missing", "/project")).rejects.toThrow("The existing engine session is unavailable.");

      expect(created).not.toHaveBeenCalled();
      expect(await adapter.listSessions()).toEqual([]);
    });
  });

  describe("removeSession", () => {
    it("delegates to the engine's existing deletion path for the selected session only", async () => {
      const adapter = new TestAdapter();
      const selected = await adapter.createSession("/selected");
      const retained = await adapter.createSession("/retained");
      const remove = vi.spyOn(adapter, "deleteSession");

      await adapter.removeSession(selected.id);

      expect(remove).toHaveBeenCalledExactlyOnceWith(selected.id);
      expect(await adapter.getSession(selected.id)).toBeNull();
      expect(await adapter.getSession(retained.id)).toBe(retained);
    });
  });

  describe("setSessionArchived", () => {
    it("rejects unsupported archive mutations while preserving the existing conversation", async () => {
      const adapter = new TestAdapter();
      const session = await adapter.createSession("/existing-project");

      await expect(adapter.setSessionArchived(session.id, true)).rejects.toThrow("This engine does not support archiving sessions.");

      expect(await adapter.getSession(session.id)).toBe(session);
      expect(session.archived).toBeUndefined();
    });
  });

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
        (v: Entry) => v,
        (v: Entry) => v.sessionId,
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
