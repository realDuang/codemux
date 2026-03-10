import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs";
import { FeishuSessionMapper } from "../../../../../electron/main/channels/feishu/feishu-session-mapper";
import type { GroupBinding, StreamingSession, P2PChatState, PendingSelection, TempSession } from "../../../../../electron/main/channels/feishu/feishu-types";
import type { EngineType } from "../../../../../src/types/unified";

vi.mock("fs");
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/userData"),
  },
}));
vi.mock("../../../../../electron/main/services/logger", () => ({
  feishuLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("FeishuSessionMapper", () => {
  let mapper: FeishuSessionMapper;

  const createMockBinding = (chatId: string, conversationId: string): GroupBinding => ({
    chatId,
    conversationId,
    engineType: "openai" as EngineType,
    directory: "/mock/dir",
    projectId: "mock-project",
    ownerOpenId: "mock-owner",
    streamingSessions: new Map(),
    createdAt: Date.now(),
  });

  const createMockStreamingSession = (feishuId: string, convId: string, msgId: string): StreamingSession => ({
    feishuMessageId: feishuId,
    conversationId: convId,
    messageId: msgId,
    textBuffer: "",
    lastPatchTime: Date.now(),
    patchTimer: null,
    completed: false,
    toolCounts: new Map(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mapper = new FeishuSessionMapper();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Group Bindings", () => {
    it("creates, retrieves, and identifies group bindings correctly", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      
      mapper.createGroupBinding(binding);
      
      expect(mapper.getGroupBinding("chat-1")).toBe(binding);
      expect(mapper.findGroupByConversationId("conv-1")).toBe(binding);
      expect(mapper.findGroupChatIdByConversationId("conv-1")).toBe("chat-1");
      expect(mapper.isGroupChat("chat-1")).toBe(true);
      expect(mapper.isGroupChat("chat-unknown")).toBe(false);
      expect(mapper.hasGroupForConversation("conv-1")).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("removes group binding and returns it; returns undefined for nonexistent", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      mapper.createGroupBinding(binding);
      
      const removed = mapper.removeGroupBinding("chat-1");
      const removedNone = mapper.removeGroupBinding("chat-none");
      
      expect(removed).toBe(binding);
      expect(removedNone).toBeUndefined();
      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();
      expect(mapper.findGroupByConversationId("conv-1")).toBeUndefined();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(2); // One for create, one for remove
    });

    it("cleans up streaming timers when removing a group binding", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      const session = createMockStreamingSession("f-1", "conv-1", "m-1");
      const timer = setTimeout(() => {}, 1000);
      session.patchTimer = timer;
      binding.streamingSessions.set("m-1", session);
      
      mapper.createGroupBinding(binding);
      const spy = vi.spyOn(global, "clearTimeout");
      
      mapper.removeGroupBinding("chat-1");
      
      expect(spy).toHaveBeenCalledWith(timer);
      expect(session.patchTimer).toBeNull();
      expect(binding.streamingSessions.size).toBe(0);
    });

    it("verifies persistence check for unbound conversations", () => {
      expect(mapper.hasGroupForConversation("conv-new")).toBe(false);
    });
  });

  describe("Persistence", () => {
    it("loads bindings from disk correctly", () => {
      const persistedData = [
        {
          chatId: "chat-1",
          conversationId: "conv-1",
          engineType: "openai",
          directory: "/p/1",
          projectId: "p1",
          ownerOpenId: "user-1",
          createdAt: 12345,
        }
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(persistedData));

      mapper.loadBindings();

      const binding = mapper.getGroupBinding("chat-1");
      expect(binding).toBeDefined();
      expect(binding?.projectId).toBe("p1");
      expect(mapper.findGroupByConversationId("conv-1")).toBeDefined();
    });

    it("handles missing file or corrupt JSON during load", () => {
      // Case 1: File doesn't exist
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mapper.loadBindings();
      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();

      // Case 2: Corrupt JSON
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("invalid json");
      mapper.loadBindings();
      expect(mapper.getGroupBinding("chat-1")).toBeUndefined();
    });
  });

  describe("Concurrency Guard", () => {
    it("marks and unmarks groups as being created correctly", () => {
      const convId = "conv-123";
      
      const firstMark = mapper.markCreating(convId);
      const secondMark = mapper.markCreating(convId);
      
      expect(firstMark).toBe(true);
      expect(secondMark).toBe(false);
      
      mapper.unmarkCreating(convId);
      const thirdMark = mapper.markCreating(convId);
      expect(thirdMark).toBe(true);
    });
  });

  describe("P2P Chat State", () => {
    it("gets or creates P2P chat state correctly", () => {
      const state1 = mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const state2 = mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const stateOther = mapper.getP2PChat("p2p-other");

      expect(state1).toBe(state2);
      expect(state1.chatId).toBe("p2p-1");
      expect(stateOther).toBeUndefined();
    });

    it("manages pending selections and project state for P2P chats", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const project = { directory: "/dir", engineType: "openai" as EngineType, projectId: "proj" };
      const selection: PendingSelection = { type: "project", projects: [] };

      mapper.setP2PLastProject("p2p-1", project);
      mapper.setPendingSelection("p2p-1", selection);
      
      const state = mapper.getP2PChat("p2p-1");
      expect(state?.lastSelectedProject).toEqual(project);
      expect(mapper.getPendingSelection("p2p-1")).toEqual(selection);

      mapper.clearPendingSelection("p2p-1");
      expect(mapper.getPendingSelection("p2p-1")).toBeUndefined();
    });

    it("manages openId mappings and pending selections by openId", () => {
      const openId = "open-123";
      const chatId = "p2p-123";
      const selection: PendingSelection = { type: "session", sessions: [] };

      mapper.setOpenIdMapping(openId, chatId);
      mapper.setPendingSelectionByOpenId(openId, selection);

      expect(mapper.getChatIdByOpenId(openId)).toBe(chatId);
      
      const taken = mapper.takePendingSelectionByOpenId(openId);
      const takenAgain = mapper.takePendingSelectionByOpenId(openId);

      expect(taken).toEqual(selection);
      expect(takenAgain).toBeUndefined(); // Should be cleared after take
    });
  });

  describe("Streaming Sessions", () => {
    it("registers and retrieves streaming sessions by conversationId", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      mapper.createGroupBinding(binding);
      
      const session = createMockStreamingSession("f-1", "conv-1", "msg-1");
      mapper.registerStreamingSession("chat-1", "msg-1", session);

      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBe(session);
      
      // Test missing group
      mapper.registerStreamingSession("chat-none", "msg-2", session);
      expect(mapper.getStreamingSession("none", "msg-2")).toBeUndefined();
    });

    it("removes streaming session and clears its timer", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      mapper.createGroupBinding(binding);
      const session = createMockStreamingSession("f-1", "conv-1", "msg-1");
      const timer = setTimeout(() => {}, 1000);
      session.patchTimer = timer;
      mapper.registerStreamingSession("chat-1", "msg-1", session);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.removeStreamingSession("conv-1", "msg-1");

      expect(spy).toHaveBeenCalledWith(timer);
      expect(mapper.getStreamingSession("conv-1", "msg-1")).toBeUndefined();
    });
  });

  describe("Temp Sessions", () => {
    it("manages temp session lifecycle and reverse index lookup", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const tempSession: TempSession = {
        conversationId: "temp-conv",
        engineType: "openai",
        directory: "/tmp",
        projectId: "tmp-p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false
      };

      mapper.setTempSession("p2p-1", tempSession);
      
      expect(mapper.getTempSession("p2p-1")).toBe(tempSession);
      expect(mapper.findP2PChatByTempConversation("temp-conv")).toBe("p2p-1");

      // Test clearing
      mapper.clearTempSession("p2p-1");
      expect(mapper.getTempSession("p2p-1")).toBeUndefined();
      expect(mapper.findP2PChatByTempConversation("temp-conv")).toBeUndefined();
    });

    it("cleans up streaming timer in temp session when cleared", () => {
      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const timer = setTimeout(() => {}, 1000);
      const tempSession: TempSession = {
        conversationId: "temp-conv",
        engineType: "openai",
        directory: "/tmp",
        projectId: "tmp-p",
        lastActiveAt: Date.now(),
        messageQueue: [],
        processing: false,
        streamingSession: { patchTimer: timer } as any
      };

      mapper.setTempSession("p2p-1", tempSession);
      const spy = vi.spyOn(global, "clearTimeout");
      
      mapper.clearTempSession("p2p-1");
      expect(spy).toHaveBeenCalledWith(timer);
    });
  });

  describe("Deduplication", () => {
    it("identifies duplicate messages and maintains LRU limit", () => {
      // Should not be duplicate first time
      expect(mapper.isDuplicate("msg-1")).toBe(false);
      // Should be duplicate second time
      expect(mapper.isDuplicate("msg-1")).toBe(true);

      // Fill up to limit (1000)
      for (let i = 2; i <= 1000; i++) {
        mapper.isDuplicate(`msg-${i}`);
      }
      
      // Limit reached, adding one more should evict msg-1
      mapper.isDuplicate("msg-1001");
      
      // msg-1 should now be "new" again because it was evicted
      expect(mapper.isDuplicate("msg-1")).toBe(false);
    });
  });

  describe("Cleanup", () => {
    it("clears all timers across groups and temp sessions", () => {
      const binding = createMockBinding("chat-1", "conv-1");
      const timer1 = setTimeout(() => {}, 1000);
      binding.streamingSessions.set("m1", { patchTimer: timer1 } as any);
      mapper.createGroupBinding(binding);

      mapper.getOrCreateP2PChat("p2p-1", "user-1");
      const timer2 = setTimeout(() => {}, 1000);
      mapper.setTempSession("p2p-1", {
        conversationId: "temp",
        streamingSession: { patchTimer: timer2 }
      } as any);

      const spy = vi.spyOn(global, "clearTimeout");
      mapper.cleanup();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(timer1);
      expect(spy).toHaveBeenCalledWith(timer2);
    });
  });
});
