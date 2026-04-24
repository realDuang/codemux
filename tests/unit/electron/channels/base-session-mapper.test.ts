import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import {
  BaseSessionMapper,
  type BaseGroupBinding,
  type BaseP2PChatState,
  type BaseTempSession,
  type BasePendingSelection,
  type BasePendingQuestion,
  type PersistedBinding,
} from "../../../../electron/main/channels/base-session-mapper";
import type { StreamingSession } from "../../../../electron/main/channels/streaming/streaming-types";
import type { EngineType } from "../../../../src/types/unified";

// --- Mocks ---

vi.mock("fs");

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
  channelLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Helpers ---

function makeBinding(chatId: string, conversationId: string): BaseGroupBinding {
  return {
    chatId,
    conversationId,
    engineType: "claude" as EngineType,
    directory: "/test/dir",
    projectId: "proj-1",
    streamingSessions: new Map(),
    createdAt: 1000,
  };
}

function makeStreamingSession(overrides?: Partial<StreamingSession>): StreamingSession {
  return {
    platformMessageId: "platform-msg-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    chatId: "chat-1",
    textBuffer: "",
    lastPatchTime: Date.now(),
    patchTimer: null,
    completed: false,
    finalReplySent: false,
    toolCounts: new Map(),
    ...overrides,
  };
}

function makeTempSession(conversationId: string, overrides?: Partial<BaseTempSession>): BaseTempSession {
  return {
    conversationId,
    engineType: "claude" as EngineType,
    directory: "/tmp",
    projectId: "tmp-proj",
    lastActiveAt: Date.now(),
    messageQueue: [],
    processing: false,
    ...overrides,
  };
}

// --- Tests ---

describe("BaseSessionMapper", () => {
  let mapper: BaseSessionMapper;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default fs mocks: dir does not exist, file does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.renameSync).mockReturnValue(undefined);
    mapper = new BaseSessionMapper("test-channel");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe("constructor", () => {
    it("uses default maxProcessedIds of 1000 when not specified", () => {
      const m = new BaseSessionMapper("chan");
      // Fill 1000 entries
      for (let i = 0; i < 1000; i++) {
        m.isDuplicate(`id-${i}`);
      }
      // id-0 is the first entry; adding one more should evict it
      m.isDuplicate("id-extra");
      // id-0 should now be evicted — not a duplicate
      expect(m.isDuplicate("id-0")).toBe(false);
    });

    it("respects custom maxProcessedIds option", () => {
      const m = new BaseSessionMapper("chan", { maxProcessedIds: 3 });
      m.isDuplicate("a");
      m.isDuplicate("b");
      m.isDuplicate("c");
      // Adding a 4th evicts "a"
      m.isDuplicate("d");
      // "a" should be evicted
      expect(m.isDuplicate("a")).toBe(false);
    });
  });

  // =========================================================================
  // Persistence — loadBindings
  // =========================================================================

  describe("loadBindings", () => {
    it("does nothing when the bindings file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mapper.loadBindings();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(mapper.getGroupBinding("any")).toBeUndefined();
    });

    it("loads and populates group bindings when file exists", () => {
      const items: PersistedBinding[] = [
        {
          chatId: "chat-1",
          conversationId: "conv-1",
          engineType: "claude",
          directory: "/dir/1",
          projectId: "proj-1",
          createdAt: 100,
        },
        {
          chatId: "chat-2",
          conversationId: "conv-2",
          engineType: "openai",
          directory: "/dir/2",
          projectId: "proj-2",
          createdAt: 200,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(items));

      mapper.loadBindings();

      const b1 = mapper.getGroupBinding("chat-1");
      expect(b1).toBeDefined();
      expect(b1?.conversationId).toBe("conv-1");
      expect(b1?.engineType).toBe("claude");
      expect(b1?.streamingSessions).toBeInstanceOf(Map);

      const b2 = mapper.getGroupBinding("chat-2");
      expect(b2).toBeDefined();
      expect(b2?.projectId).toBe("proj-2");

      expect(mapper.findGroupByConversationId("conv-1")).toBe(b1);
      expect(mapper.findGroupByConversationId("conv-2")).toBe(b2);
    });

    it("handles corrupt JSON without throwing", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{");

      expect(() => mapper.loadBindings()).not.toThrow();
      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();
    });

    it("handles readFileSync throwing without propagating", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("Read error");
      });

      expect(() => mapper.loadBindings()).not.toThrow();
    });
  });

  // =========================================================================
  // Persistence — saveBindings (via createGroupBinding)
  // =========================================================================

  describe("saveBindings", () => {
    it("creates the directory when it does not exist before saving", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const binding = makeBinding("chat-1", "conv-1");

      mapper.createGroupBinding(binding);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("channels"),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it("skips mkdir when directory already exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const binding = makeBinding("chat-1", "conv-1");

      mapper.createGroupBinding(binding);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it("handles write errors without throwing", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error("Disk full");
      });

      expect(() => mapper.createGroupBinding(makeBinding("chat-1", "conv-1"))).not.toThrow();
    });

    it("uses userData path when app.isPackaged is true", async () => {
      const { app } = await import("electron");
      (app as any).isPackaged = true;

      mapper.createGroupBinding(makeBinding("chat-x", "conv-x"));

      expect(app.getPath).toHaveBeenCalledWith("userData");
      (app as any).isPackaged = false;
    });

    it("uses cwd path when app.isPackaged is false", () => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/mock/cwd");
      mapper.createGroupBinding(makeBinding("chat-y", "conv-y"));

      expect(cwdSpy).toHaveBeenCalled();
      cwdSpy.mockRestore();
    });
  });

  // =========================================================================
  // Group Binding Methods
  // =========================================================================

  describe("createGroupBinding", () => {
    it("stores binding in the group map and sets up conversation index", () => {
      const binding = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(binding);

      expect(mapper.getGroupBinding("chat-1")).toBe(binding);
      expect(mapper.findGroupByConversationId("conv-1")).toBe(binding);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("handles multiple bindings without collision", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      mapper.createGroupBinding(makeBinding("chat-2", "conv-2"));

      expect(mapper.getGroupBinding("chat-1")).toBeDefined();
      expect(mapper.getGroupBinding("chat-2")).toBeDefined();
      expect(mapper.findGroupByConversationId("conv-1")).toBeDefined();
      expect(mapper.findGroupByConversationId("conv-2")).toBeDefined();
    });
  });

  describe("getGroupBinding", () => {
    it("returns undefined for unknown chatId", () => {
      expect(mapper.getGroupBinding("does-not-exist")).toBeUndefined();
    });

    it("returns binding for known chatId", () => {
      const b = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(b);
      expect(mapper.getGroupBinding("chat-1")).toBe(b);
    });
  });

  describe("findGroupByConversationId", () => {
    it("returns undefined when conversationId is not indexed", () => {
      expect(mapper.findGroupByConversationId("unknown-conv")).toBeUndefined();
    });

    it("returns undefined when chatId is in index but binding was removed", () => {
      // Manually corrupt scenario: index present but binding gone — not directly achievable
      // through public API; verify normal path instead
      const b = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(b);
      mapper.removeGroupBinding("chat-1");
      expect(mapper.findGroupByConversationId("conv-1")).toBeUndefined();
    });

    it("returns the binding when conversationId is known", () => {
      const b = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(b);
      expect(mapper.findGroupByConversationId("conv-1")).toBe(b);
    });
  });

  describe("isGroupChat", () => {
    it("returns false for unknown chatId", () => {
      expect(mapper.isGroupChat("no-such-chat")).toBe(false);
    });

    it("returns true after binding is created", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      expect(mapper.isGroupChat("chat-1")).toBe(true);
    });

    it("returns false after binding is removed", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      mapper.removeGroupBinding("chat-1");
      expect(mapper.isGroupChat("chat-1")).toBe(false);
    });
  });

  describe("hasGroupForConversation", () => {
    it("returns false for unindexed conversation", () => {
      expect(mapper.hasGroupForConversation("conv-x")).toBe(false);
    });

    it("returns true after binding is created", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      expect(mapper.hasGroupForConversation("conv-1")).toBe(true);
    });
  });

  describe("removeGroupBinding", () => {
    it("returns undefined for a non-existent binding", () => {
      expect(mapper.removeGroupBinding("ghost")).toBeUndefined();
    });

    it("removes binding and returns it", () => {
      const b = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(b);

      const removed = mapper.removeGroupBinding("chat-1");

      expect(removed).toBe(b);
      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();
      expect(mapper.findGroupByConversationId("conv-1")).toBeUndefined();
      expect(mapper.isGroupChat("chat-1")).toBe(false);
    });

    it("clears patchTimers on streaming sessions and marks them null", () => {
      const b = makeBinding("chat-1", "conv-1");
      const timer = setTimeout(() => {}, 5000);
      const session = makeStreamingSession({ patchTimer: timer });
      b.streamingSessions.set("msg-1", session);
      mapper.createGroupBinding(b);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.removeGroupBinding("chat-1");

      expect(spy).toHaveBeenCalledWith(timer);
      expect(session.patchTimer).toBeNull();
      expect(b.streamingSessions.size).toBe(0);
    });

    it("does not call clearTimeout for sessions with null patchTimer", () => {
      const b = makeBinding("chat-1", "conv-1");
      b.streamingSessions.set("msg-1", makeStreamingSession({ patchTimer: null }));
      mapper.createGroupBinding(b);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.removeGroupBinding("chat-1");

      expect(spy).not.toHaveBeenCalled();
    });

    it("persists bindings after removal", () => {
      vi.mocked(fs.writeFileSync).mockClear();
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      mapper.removeGroupBinding("chat-1");
      // writeFileSync is called once for create and once for remove
      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Concurrency Guard
  // =========================================================================

  describe("markCreating / unmarkCreating", () => {
    it("returns true on first mark and false on a repeated mark", () => {
      expect(mapper.markCreating("conv-1")).toBe(true);
      expect(mapper.markCreating("conv-1")).toBe(false);
    });

    it("allows re-marking after unmark", () => {
      mapper.markCreating("conv-1");
      mapper.unmarkCreating("conv-1");
      expect(mapper.markCreating("conv-1")).toBe(true);
    });

    it("independent conversation IDs do not interfere", () => {
      expect(mapper.markCreating("conv-a")).toBe(true);
      expect(mapper.markCreating("conv-b")).toBe(true);
      expect(mapper.markCreating("conv-a")).toBe(false);
    });
  });

  // =========================================================================
  // P2P Chat State
  // =========================================================================

  describe("getOrCreateP2PChat", () => {
    it("creates a new P2P chat state when chatId is unknown", () => {
      const state = mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(state).toBeDefined();
      expect(state.chatId).toBe("p2p-1");
      expect(state.userId).toBe("user-1");
    });

    it("returns the same instance on repeated calls", () => {
      const s1 = mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const s2 = mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(s1).toBe(s2);
    });
  });

  describe("getP2PChat", () => {
    it("returns undefined for unknown chatId", () => {
      expect(mapper.getP2PChat("unknown")).toBeUndefined();
    });

    it("returns state after it is created", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(mapper.getP2PChat("p2p-1")).toBeDefined();
    });
  });

  describe("setP2PLastProject", () => {
    it("updates lastSelectedProject when state exists", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const project = { directory: "/some/dir", engineType: "claude" as EngineType, projectId: "proj-x" };
      mapper.setP2PLastProject("p2p-1", project);
      expect(mapper.getP2PChat("p2p-1")?.lastSelectedProject).toEqual(project);
    });

    it("is a no-op when state does not exist", () => {
      expect(() =>
        mapper.setP2PLastProject("no-chat", { directory: "/d", projectId: "p" }),
      ).not.toThrow();
    });

    it("works without engineType (optional field)", () => {
      mapper.getOrCreateP2PChat("p2p-2", "user-2");
      mapper.setP2PLastProject("p2p-2", { directory: "/d", projectId: "p" });
      expect(mapper.getP2PChat("p2p-2")?.lastSelectedProject?.engineType).toBeUndefined();
    });
  });

  describe("setPendingSelection", () => {
    it("sets pendingSelection on P2P chat state when it exists", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const sel: BasePendingSelection = { type: "project", projects: [] };
      mapper.setPendingSelection("p2p-1", sel);
      expect(mapper.getP2PChat("p2p-1")?.pendingSelection).toEqual(sel);
    });

    it("stores selection in standalonePendingSelections when P2P state does not exist", () => {
      const sel: BasePendingSelection = { type: "session", sessions: [] };
      mapper.setPendingSelection("group-chat-1", sel);
      expect(mapper.getPendingSelection("group-chat-1")).toEqual(sel);
    });
  });

  describe("getPendingSelection", () => {
    it("returns undefined when no selection exists anywhere", () => {
      expect(mapper.getPendingSelection("non-existent")).toBeUndefined();
    });

    it("prefers P2P chat state over standalone when both could be set", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const sel: BasePendingSelection = { type: "project" };
      mapper.setPendingSelection("p2p-1", sel);
      expect(mapper.getPendingSelection("p2p-1")).toEqual(sel);
    });

    it("falls back to standalone store when P2P state has no selection", () => {
      const sel: BasePendingSelection = { type: "session" };
      mapper.setPendingSelection("group-1", sel);
      expect(mapper.getPendingSelection("group-1")).toEqual(sel);
    });
  });

  describe("clearPendingSelection", () => {
    it("clears pendingSelection from P2P chat state", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setPendingSelection("p2p-1", { type: "project" });
      mapper.clearPendingSelection("p2p-1");
      expect(mapper.getP2PChat("p2p-1")?.pendingSelection).toBeUndefined();
    });

    it("clears selection from standalone store", () => {
      mapper.setPendingSelection("group-1", { type: "session" });
      mapper.clearPendingSelection("group-1");
      expect(mapper.getPendingSelection("group-1")).toBeUndefined();
    });

    it("clears both P2P and standalone simultaneously", () => {
      // Setup standalone
      mapper.setPendingSelection("chat-x", { type: "project" });
      // Now also create P2P state for same chatId
      mapper.getOrCreateP2PChat("chat-x", "user-x");
      mapper.setPendingSelection("chat-x", { type: "session" }); // goes to P2P state
      // Manually set standalone for same key (simulate edge case)
      mapper.setPendingSelection("chat-x", { type: "project" });
      mapper.clearPendingSelection("chat-x");
      expect(mapper.getPendingSelection("chat-x")).toBeUndefined();
    });

    it("does not throw when chatId does not exist anywhere", () => {
      expect(() => mapper.clearPendingSelection("ghost-chat")).not.toThrow();
    });
  });

  // =========================================================================
  // User ID Mapping
  // =========================================================================

  describe("setUserIdMapping / getChatIdByUserId", () => {
    it("maps userId to chatId and retrieves it", () => {
      mapper.setUserIdMapping("user-123", "chat-abc");
      expect(mapper.getChatIdByUserId("user-123")).toBe("chat-abc");
    });

    it("returns undefined for unmapped userId", () => {
      expect(mapper.getChatIdByUserId("unknown-user")).toBeUndefined();
    });

    it("overwrites an existing mapping", () => {
      mapper.setUserIdMapping("user-123", "chat-old");
      mapper.setUserIdMapping("user-123", "chat-new");
      expect(mapper.getChatIdByUserId("user-123")).toBe("chat-new");
    });
  });

  // =========================================================================
  // Streaming Sessions
  // =========================================================================

  describe("registerStreamingSession", () => {
    it("adds session to existing group binding", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      const session = makeStreamingSession();
      mapper.registerStreamingSession("chat-1", "msg-1", session);

      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBe(session);
    });

    it("is a no-op when the group binding does not exist", () => {
      const session = makeStreamingSession();
      expect(() =>
        mapper.registerStreamingSession("no-group", "msg-1", session),
      ).not.toThrow();
      expect(mapper.getStreamingSession("no-conv", "msg-1")).toBeUndefined();
    });
  });

  describe("getStreamingSession", () => {
    it("returns undefined when conversationId is not mapped to any group", () => {
      expect(mapper.getStreamingSession("unknown-conv", "msg-1")).toBeUndefined();
    });

    it("returns undefined when group exists but messageId is absent", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      expect(mapper.getStreamingSession("conv-1", "no-such-msg")).toBeUndefined();
    });

    it("returns session when both conversationId and messageId are known", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      const session = makeStreamingSession();
      mapper.registerStreamingSession("chat-1", "msg-1", session);
      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBe(session);
    });
  });

  describe("removeStreamingSession", () => {
    it("is a no-op when the binding does not exist", () => {
      expect(() => mapper.removeStreamingSession("no-conv", "msg-1")).not.toThrow();
    });

    it("removes the session without touching timer when patchTimer is null", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      mapper.registerStreamingSession("chat-1", "msg-1", makeStreamingSession({ patchTimer: null }));

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.removeStreamingSession("conv-1", "msg-1");

      expect(spy).not.toHaveBeenCalled();
      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBeUndefined();
    });

    it("clears the patchTimer before removing the session", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      const timer = setTimeout(() => {}, 5000);
      mapper.registerStreamingSession("chat-1", "msg-1", makeStreamingSession({ patchTimer: timer }));

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.removeStreamingSession("conv-1", "msg-1");

      expect(spy).toHaveBeenCalledWith(timer);
      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBeUndefined();
    });

    it("is safe to remove a non-existing messageId from a known group", () => {
      mapper.createGroupBinding(makeBinding("chat-1", "conv-1"));
      expect(() => mapper.removeStreamingSession("conv-1", "ghost-msg")).not.toThrow();
    });
  });

  // =========================================================================
  // Temp Sessions
  // =========================================================================

  describe("setTempSession", () => {
    it("is a no-op when P2P chat state does not exist", () => {
      expect(() =>
        mapper.setTempSession("no-chat", makeTempSession("temp-conv")),
      ).not.toThrow();
    });

    it("sets temp session and builds reverse index", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const temp = makeTempSession("temp-conv-1");
      mapper.setTempSession("p2p-1", temp);

      expect(mapper.getTempSession("p2p-1")).toBe(temp);
      expect(mapper.findP2PChatByTempConversation("temp-conv-1")).toBe("p2p-1");
    });

    it("removes old reverse index entry when replacing an existing temp session", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const temp1 = makeTempSession("temp-conv-OLD");
      mapper.setTempSession("p2p-1", temp1);

      const temp2 = makeTempSession("temp-conv-NEW");
      mapper.setTempSession("p2p-1", temp2);

      expect(mapper.findP2PChatByTempConversation("temp-conv-OLD")).toBeUndefined();
      expect(mapper.findP2PChatByTempConversation("temp-conv-NEW")).toBe("p2p-1");
    });
  });

  describe("getTempSession", () => {
    it("returns undefined when P2P state does not exist", () => {
      expect(mapper.getTempSession("no-chat")).toBeUndefined();
    });

    it("returns undefined when P2P state has no temp session", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(mapper.getTempSession("p2p-1")).toBeUndefined();
    });
  });

  describe("clearTempSession", () => {
    it("is a no-op when P2P state does not exist", () => {
      expect(() => mapper.clearTempSession("no-chat")).not.toThrow();
    });

    it("is a no-op when P2P state has no temp session", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(() => mapper.clearTempSession("p2p-1")).not.toThrow();
    });

    it("clears temp session and removes reverse index entry", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setTempSession("p2p-1", makeTempSession("temp-conv-1"));

      mapper.clearTempSession("p2p-1");

      expect(mapper.getTempSession("p2p-1")).toBeUndefined();
      expect(mapper.findP2PChatByTempConversation("temp-conv-1")).toBeUndefined();
    });

    it("clears patchTimer from the temp session's streaming session when present", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const timer = setTimeout(() => {}, 5000);
      const temp = makeTempSession("temp-conv-1", {
        streamingSession: makeStreamingSession({ patchTimer: timer }),
      });
      mapper.setTempSession("p2p-1", temp);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.clearTempSession("p2p-1");

      expect(spy).toHaveBeenCalledWith(timer);
    });

    it("does not call clearTimeout when streamingSession.patchTimer is null", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const temp = makeTempSession("temp-conv-1", {
        streamingSession: makeStreamingSession({ patchTimer: null }),
      });
      mapper.setTempSession("p2p-1", temp);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.clearTempSession("p2p-1");

      expect(spy).not.toHaveBeenCalled();
    });

    it("does not call clearTimeout when there is no streamingSession", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setTempSession("p2p-1", makeTempSession("temp-conv-1", { streamingSession: undefined }));

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.clearTempSession("p2p-1");

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("findP2PChatByTempConversation", () => {
    it("returns undefined for unknown conversationId", () => {
      expect(mapper.findP2PChatByTempConversation("ghost-conv")).toBeUndefined();
    });

    it("returns chatId after temp session is registered", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setTempSession("p2p-1", makeTempSession("temp-1"));
      expect(mapper.findP2PChatByTempConversation("temp-1")).toBe("p2p-1");
    });
  });

  // =========================================================================
  // Pending Questions
  // =========================================================================

  describe("setPendingQuestion / getPendingQuestion / clearPendingQuestion", () => {
    it("stores and retrieves a pending question", () => {
      const q: BasePendingQuestion = { questionId: "q-1", sessionId: "sess-1" };
      mapper.setPendingQuestion("chat-1", q);
      expect(mapper.getPendingQuestion("chat-1")).toEqual(q);
    });

    it("returns undefined for chatId with no pending question", () => {
      expect(mapper.getPendingQuestion("no-chat")).toBeUndefined();
    });

    it("clears the pending question", () => {
      const q: BasePendingQuestion = { questionId: "q-1", sessionId: "sess-1" };
      mapper.setPendingQuestion("chat-1", q);
      mapper.clearPendingQuestion("chat-1");
      expect(mapper.getPendingQuestion("chat-1")).toBeUndefined();
    });

    it("overrides a previous pending question", () => {
      mapper.setPendingQuestion("chat-1", { questionId: "q-old", sessionId: "s-old" });
      mapper.setPendingQuestion("chat-1", { questionId: "q-new", sessionId: "s-new" });
      expect(mapper.getPendingQuestion("chat-1")?.questionId).toBe("q-new");
    });
  });

  // =========================================================================
  // Deduplication
  // =========================================================================

  describe("isDuplicate", () => {
    it("returns false the first time a messageId is seen", () => {
      expect(mapper.isDuplicate("new-msg")).toBe(false);
    });

    it("returns true when the same messageId is seen again", () => {
      mapper.isDuplicate("dup-msg");
      expect(mapper.isDuplicate("dup-msg")).toBe(true);
    });

    it("different messageIds are all treated as new", () => {
      expect(mapper.isDuplicate("msg-a")).toBe(false);
      expect(mapper.isDuplicate("msg-b")).toBe(false);
      expect(mapper.isDuplicate("msg-c")).toBe(false);
    });

    it("evicts the oldest entry when maxProcessedIds is reached (LRU eviction)", () => {
      const m = new BaseSessionMapper("chan", { maxProcessedIds: 5 });
      // Fill to the limit
      m.isDuplicate("a");
      m.isDuplicate("b");
      m.isDuplicate("c");
      m.isDuplicate("d");
      m.isDuplicate("e");
      // Adding the 6th triggers eviction of "a" (the first inserted)
      m.isDuplicate("f");
      // "a" should be evicted and seen as new
      expect(m.isDuplicate("a")).toBe(false);
      // "b" was second; after evicting "a" and re-adding "a", "b" is next
    });

    it("does not evict when below the limit", () => {
      const m = new BaseSessionMapper("chan", { maxProcessedIds: 5 });
      m.isDuplicate("a");
      m.isDuplicate("b");
      // Only 2 entries, limit is 5 — "a" should still be a duplicate
      expect(m.isDuplicate("a")).toBe(true);
    });
  });

  // =========================================================================
  // Cleanup
  // =========================================================================

  describe("cleanup", () => {
    it("clears patchTimers from all group binding streaming sessions", () => {
      const b1 = makeBinding("chat-1", "conv-1");
      const b2 = makeBinding("chat-2", "conv-2");
      const timer1 = setTimeout(() => {}, 5000);
      const timer2 = setTimeout(() => {}, 5000);
      b1.streamingSessions.set("msg-1", makeStreamingSession({ patchTimer: timer1 }));
      b2.streamingSessions.set("msg-2", makeStreamingSession({ patchTimer: timer2 }));
      mapper.createGroupBinding(b1);
      mapper.createGroupBinding(b2);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.cleanup();

      expect(spy).toHaveBeenCalledWith(timer1);
      expect(spy).toHaveBeenCalledWith(timer2);
      expect(b1.streamingSessions.size).toBe(0);
      expect(b2.streamingSessions.size).toBe(0);
    });

    it("skips clearTimeout for streaming sessions with null patchTimer", () => {
      const b = makeBinding("chat-1", "conv-1");
      b.streamingSessions.set("msg-1", makeStreamingSession({ patchTimer: null }));
      mapper.createGroupBinding(b);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.cleanup();

      expect(spy).not.toHaveBeenCalled();
    });

    it("clears patchTimers from P2P temp session streaming sessions", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const timer = setTimeout(() => {}, 5000);
      mapper.setTempSession(
        "p2p-1",
        makeTempSession("temp-conv", {
          streamingSession: makeStreamingSession({ patchTimer: timer }),
        }),
      );

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.cleanup();

      expect(spy).toHaveBeenCalledWith(timer);
    });

    it("sets patchTimer to null on temp session's streaming session after cleanup", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const timer = setTimeout(() => {}, 5000);
      const ss = makeStreamingSession({ patchTimer: timer });
      mapper.setTempSession("p2p-1", makeTempSession("temp-conv", { streamingSession: ss }));

      mapper.cleanup();

      expect(ss.patchTimer).toBeNull();
    });

    it("does not throw when there are no bindings or P2P chats", () => {
      expect(() => mapper.cleanup()).not.toThrow();
    });

    it("handles P2P chat with no tempSession without throwing", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      expect(() => mapper.cleanup()).not.toThrow();
    });

    it("handles P2P chat with tempSession but no streamingSession without throwing", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setTempSession("p2p-1", makeTempSession("temp-conv", { streamingSession: undefined }));
      expect(() => mapper.cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // Subclass Extensibility — serializeBinding / deserializeBinding
  // =========================================================================

  describe("serializeBinding / deserializeBinding", () => {
    it("round-trips a base binding through serialize → deserialize", () => {
      const original = makeBinding("chat-x", "conv-x");
      // Access protected methods via a subclass
      class TestMapper extends BaseSessionMapper {
        publicSerialize(b: BaseGroupBinding) { return this.serializeBinding(b); }
        publicDeserialize(p: PersistedBinding) { return this.deserializeBinding(p); }
      }
      const tm = new TestMapper("test");
      const persisted = tm.publicSerialize(original);

      expect(persisted.chatId).toBe("chat-x");
      expect(persisted.conversationId).toBe("conv-x");
      expect(persisted.engineType).toBe("claude");
      expect(persisted.directory).toBe("/test/dir");
      expect(persisted.projectId).toBe("proj-1");
      expect(persisted.createdAt).toBe(1000);
      // streamingSessions should NOT be in the serialized form
      expect((persisted as any).streamingSessions).toBeUndefined();

      const runtime = tm.publicDeserialize(persisted);
      expect(runtime.chatId).toBe("chat-x");
      expect(runtime.streamingSessions).toBeInstanceOf(Map);
      expect(runtime.engineType).toBe("claude");
    });

    it("subclass can override serializeBinding to persist extra fields", () => {
      interface ExtendedBinding extends BaseGroupBinding { extra: string }
      interface ExtendedPersisted extends PersistedBinding { extra: string }

      class ExtMapper extends BaseSessionMapper<ExtendedBinding> {
        protected override serializeBinding(b: ExtendedBinding): ExtendedPersisted {
          return { ...super.serializeBinding(b), extra: b.extra };
        }
        protected override deserializeBinding(item: ExtendedPersisted): ExtendedBinding {
          return { ...super.deserializeBinding(item), extra: item.extra };
        }
      }

      const em = new ExtMapper("ext");
      const items = [
        {
          chatId: "chat-ext",
          conversationId: "conv-ext",
          engineType: "copilot",
          directory: "/ext",
          projectId: "pext",
          createdAt: 999,
          extra: "custom-value",
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(items));

      em.loadBindings();

      const b = em.getGroupBinding("chat-ext") as ExtendedBinding;
      expect(b).toBeDefined();
      expect(b.extra).toBe("custom-value");
    });
  });

  // =========================================================================
  // Standalone Pending Selections edge cases
  // =========================================================================

  describe("standalone pending selections", () => {
    it("clears standalone selection independently of P2P state", () => {
      mapper.setPendingSelection("group-chat", { type: "project" });
      expect(mapper.getPendingSelection("group-chat")).toBeDefined();
      mapper.clearPendingSelection("group-chat");
      expect(mapper.getPendingSelection("group-chat")).toBeUndefined();
    });

    it("does not affect P2P selection when clearing standalone for different chatId", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setPendingSelection("p2p-1", { type: "session" });
      mapper.setPendingSelection("group-1", { type: "project" });

      mapper.clearPendingSelection("group-1");

      expect(mapper.getPendingSelection("p2p-1")).toBeDefined();
    });
  });

  // =========================================================================
  // clearAllBindings — full wipe used by logout / token-expiry cleanup
  // =========================================================================

  describe("clearAllBindings", () => {
    it("empties every in-memory map and persists empty bindings file", () => {
      // Populate group bindings, P2P state, temp session, dedup, pending question
      const b1 = makeBinding("chat-1", "conv-1");
      mapper.createGroupBinding(b1);
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      mapper.setUserIdMapping("user-1", "p2p-1");
      mapper.setTempSession("p2p-1", makeTempSession("temp-conv-1"));
      mapper.setPendingSelection("group-x", { type: "project" });
      mapper.setPendingQuestion("chat-1", { questionId: "q1", sessionId: "s1" });
      mapper.markCreating("conv-creating");
      mapper.isDuplicate("dedup-id");

      vi.mocked(fs.writeFileSync).mockClear();
      mapper.clearAllBindings();

      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();
      expect(mapper.findGroupByConversationId("conv-1")).toBeUndefined();
      expect(mapper.getP2PChat("p2p-1")).toBeUndefined();
      expect(mapper.getChatIdByUserId("user-1")).toBeUndefined();
      expect(mapper.findP2PChatByTempConversation("temp-conv-1")).toBeUndefined();
      expect(mapper.getPendingSelection("group-x")).toBeUndefined();
      expect(mapper.getPendingQuestion("chat-1")).toBeUndefined();
      // creatingGroups cleared — markCreating works again immediately
      expect(mapper.markCreating("conv-creating")).toBe(true);
      // dedup set cleared — same id is "new" again
      expect(mapper.isDuplicate("dedup-id")).toBe(false);

      // Persisted JSON written as []
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
      expect(writeCall?.[1]).toBe("[]");
    });

    it("clears patchTimers via cleanup before wiping maps", () => {
      const b = makeBinding("chat-1", "conv-1");
      const timer = setTimeout(() => {}, 5000);
      b.streamingSessions.set("msg-1", makeStreamingSession({ patchTimer: timer }));
      mapper.createGroupBinding(b);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.clearAllBindings();

      expect(spy).toHaveBeenCalledWith(timer);
    });

    it("is safe to call when nothing is registered", () => {
      expect(() => mapper.clearAllBindings()).not.toThrow();
    });
  });
});
