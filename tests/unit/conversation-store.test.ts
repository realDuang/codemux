import fs from "fs";
import path from "path";
import os from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "electron";
import { conversationStore } from "../../electron/main/services/conversation-store";
import type { ConversationMessage, TextPart, UnifiedPart } from "../../src/types/unified";

let tmpDir: string;

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
}));

// Mock logger to suppress output
vi.mock("../../electron/main/services/logger", () => ({
  conversationStoreLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("ConversationStore", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-store-test-"));
    // Reset singleton state via any cast since they are private
    (conversationStore as any).initialized = false;
    (conversationStore as any).index = new Map();
    (conversationStore as any).basePath = "";
    (conversationStore as any).indexDirty = false;
    if ((conversationStore as any).indexTimer) {
      clearTimeout((conversationStore as any).indexTimer);
      (conversationStore as any).indexTimer = null;
    }
    // Configure mock
    vi.mocked(app.getPath).mockReturnValue(tmpDir);
    // Init
    conversationStore.init();
  });

  afterEach(() => {
    conversationStore.flushAll();
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("Lifecycle", () => {
    it("init() creates the conversations directory", () => {
      const convDir = path.join(tmpDir, "conversations");
      expect(fs.existsSync(convDir)).toBe(true);
      expect(fs.statSync(convDir).isDirectory()).toBe(true);
    });

    it("init() is idempotent", () => {
      expect(() => conversationStore.init()).not.toThrow();
      expect((conversationStore as any).initialized).toBe(true);
    });

    it("methods throw if called before init", () => {
      (conversationStore as any).initialized = false;
      expect(() => conversationStore.list()).toThrow("ConversationStore not initialized");
    });

    it("flushAll() writes pending index changes", () => {
      conversationStore.create({ engineType: "opencode", directory: "/test" });
      expect((conversationStore as any).indexDirty).toBe(true);
      
      conversationStore.flushAll();
      
      expect((conversationStore as any).indexDirty).toBe(false);
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      expect(fs.existsSync(indexPath)).toBe(true);
    });
  });

  describe("Conversation CRUD", () => {
    it("create() returns a ConversationMeta with correct fields", () => {
      const conv = conversationStore.create({ 
        engineType: "claude", 
        directory: "/projects/foo",
        title: "My Project" 
      });

      expect(conv.id).toMatch(/^conv_/);
      expect(conv.engineType).toBe("claude");
      expect(conv.directory).toBe("/projects/foo");
      expect(conv.title).toBe("My Project");
      expect(conv.createdAt).toBeLessThanOrEqual(Date.now());
      expect(conv.updatedAt).toBe(conv.createdAt);
      expect(conv.messageCount).toBe(0);
    });

    it("create() generates a default title if not provided", () => {
      const conv = conversationStore.create({ 
        engineType: "opencode", 
        directory: "/test" 
      });
      expect(conv.title).toMatch(/^Chat \d+-\d+ \d+:\d+/);
    });

    it("get() returns the conversation or null", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      expect(conversationStore.get(conv.id)).toEqual(conv);
      expect(conversationStore.get("non-existent")).toBeNull();
    });

    it("list() returns all conversations sorted by updatedAt desc", () => {
      const c1 = conversationStore.create({ engineType: "opencode", directory: "/dir1" });
      // Force a time gap
      const now = Date.now();
      const c2 = conversationStore.create({ engineType: "claude", directory: "/dir2" });
      (c2 as any).updatedAt = now + 1000;
      conversationStore.update(c2.id, { updatedAt: now + 1000 });

      const list = conversationStore.list();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(c2.id);
      expect(list[1].id).toBe(c1.id);
    });

    it("list() filters by engineType", () => {
      conversationStore.create({ engineType: "opencode", directory: "/dir" });
      conversationStore.create({ engineType: "claude", directory: "/dir" });

      const list = conversationStore.list({ engineType: "opencode" });
      expect(list.length).toBe(1);
      expect(list[0].engineType).toBe("opencode");
    });

    it("list() filters by directory (case-insensitive slash normalization)", () => {
      conversationStore.create({ engineType: "opencode", directory: "C:\\projects\\foo" });
      conversationStore.create({ engineType: "opencode", directory: "/projects/bar" });

      const list = conversationStore.list({ directory: "C:/projects/foo" });
      expect(list.length).toBe(1);
      expect(list[0].directory).toBe("C:\\projects\\foo");
    });

    it("update() updates fields and updatedAt", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const oldUpdatedAt = conv.updatedAt;
      
      // Wait a bit to ensure timestamp changes
      const future = Date.now() + 100;
      vi.useFakeTimers();
      vi.setSystemTime(future);

      conversationStore.update(conv.id, { title: "New Title" });
      
      const updated = conversationStore.get(conv.id)!;
      expect(updated.title).toBe("New Title");
      expect(updated.updatedAt).toBe(future);
      expect(updated.updatedAt).toBeGreaterThan(oldUpdatedAt);
      
      vi.useRealTimers();
    });

    it("update() preserves id and createdAt", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const originalId = conv.id;
      const originalCreatedAt = conv.createdAt;

      conversationStore.update(conv.id, { id: "hacked", createdAt: 123 } as any);

      const updated = conversationStore.get(conv.id)!;
      expect(updated.id).toBe(originalId);
      expect(updated.createdAt).toBe(originalCreatedAt);
    });

    it("delete() removes from index and deletes files", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const id = conv.id;
      
      // Create some dummy files
      const msgPath = path.join(tmpDir, "conversations", `${id}.json`);
      const stepsPath = path.join(tmpDir, "conversations", `${id}.steps.json`);
      fs.mkdirSync(path.join(tmpDir, "conversations"), { recursive: true });
      fs.writeFileSync(msgPath, "[]");
      fs.writeFileSync(stepsPath, "{}");

      conversationStore.delete(id);

      expect(conversationStore.get(id)).toBeNull();
      expect(fs.existsSync(msgPath)).toBe(false);
      expect(fs.existsSync(stepsPath)).toBe(false);
    });

    it("rename() is a shorthand for update({ title })", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      conversationStore.rename(conv.id, "Renamed");
      expect(conversationStore.get(conv.id)!.title).toBe("Renamed");
    });
  });

  describe("Messages", () => {
    const mockMsg: ConversationMessage = {
      id: "msg_1",
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", id: "part_1", messageId: "msg_1", sessionId: "s1", text: "Hello" } as TextPart]
    };

    it("listMessages() returns empty array when no file exists", () => {
      expect(conversationStore.listMessages("non-existent")).toEqual([]);
    });

    it("appendMessage() writes to disk and updates meta", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      conversationStore.appendMessage(conv.id, mockMsg);

      // Verify memory state
      const updatedConv = conversationStore.get(conv.id)!;
      expect(updatedConv.messageCount).toBe(1);
      expect(updatedConv.preview).toBe("Hello");
      // Auto-title from first user message
      expect(updatedConv.title).toBe("Hello");

      // Verify disk state
      const messages = conversationStore.listMessages(conv.id);
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe("msg_1");
    });

    it("appendMessage() handles long previews and titles", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const longText = "A".repeat(200);
      const msg: ConversationMessage = {
        ...mockMsg,
        parts: [{ type: "text", id: "p1", messageId: "m1", sessionId: "s1", text: longText } as TextPart]
      };

      conversationStore.appendMessage(conv.id, msg);
      const updated = conversationStore.get(conv.id)!;
      
      expect(updated.preview?.length).toBe(103); // 100 + "..."
      expect(updated.preview?.endsWith("...")).toBe(true);
      expect(updated.title.length).toBe(53); // 50 + "..."
      expect(updated.title.endsWith("...")).toBe(true);
    });

    it("updateMessage() updates existing message", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      conversationStore.appendMessage(conv.id, mockMsg);

      conversationStore.updateMessage(conv.id, "msg_1", { role: "assistant" });

      const messages = conversationStore.listMessages(conv.id);
      expect(messages[0].role).toBe("assistant");
    });
  });

  describe("Steps", () => {
    const mockSteps: UnifiedPart[] = [
      { type: "text", id: "s1", messageId: "m1", sessionId: "s1", text: "step 1" } as any
    ];

    it("getSteps() returns empty array when no steps file", () => {
      expect(conversationStore.getSteps("id", "msgId")).toEqual([]);
    });

    it("saveSteps() and getSteps() roundtrip", () => {
      const convId = "conv_123";
      conversationStore.saveSteps(convId, "msg_1", mockSteps);

      const saved = conversationStore.getSteps(convId, "msg_1");
      expect(saved).toEqual(mockSteps);
      
      const allSteps = conversationStore.getAllSteps(convId);
      expect(allSteps?.messages["msg_1"]).toEqual(mockSteps);
    });

    it("saveSteps() truncates large tool output", () => {
      const largeOutput = "X".repeat(20000);
      const toolStep: UnifiedPart = {
        type: "tool",
        id: "t1",
        messageId: "m1",
        sessionId: "s1",
        tool: "test",
        args: {},
        state: { status: "completed", output: largeOutput }
      } as any;

      conversationStore.saveSteps("conv_1", "msg_1", [toolStep]);
      
      const saved = conversationStore.getSteps("conv_1", "msg_1")[0] as any;
      expect(saved.state.output.length).toBeLessThan(largeOutput.length);
      expect(saved.state.output).toContain("[truncated");
    });
  });

  describe("Project Derivation", () => {
    it("deriveProjects() groups by directory and engineType", () => {
      conversationStore.create({ engineType: "opencode", directory: "/work/project-a" });
      conversationStore.create({ engineType: "opencode", directory: "/work/project-a" });
      conversationStore.create({ engineType: "claude", directory: "/work/project-a" });
      conversationStore.create({ engineType: "opencode", directory: "/work/project-b" });
      conversationStore.create({ engineType: "opencode", directory: "" }); // Should be skipped
      conversationStore.create({ engineType: "opencode", directory: "/" }); // Should be skipped

      const projects = conversationStore.deriveProjects();
      expect(projects.length).toBe(3);
      
      const names = projects.map(p => p.name).sort();
      expect(names).toEqual(["project-a", "project-a", "project-b"]);
      
      const ids = projects.map(p => p.id).sort();
      expect(ids).toContain("opencode-/work/project-a");
      expect(ids).toContain("claude-/work/project-a");
    });
  });

  describe("Engine Session Association", () => {
    it("setEngineSession() and findByEngineSession() work correctly", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      conversationStore.setEngineSession(conv.id, "session_99", { model: "gpt-4" });

      const found = conversationStore.findByEngineSession("session_99");
      expect(found?.id).toBe(conv.id);
      expect(found?.engineMeta?.model).toBe("gpt-4");

      conversationStore.clearEngineSession(conv.id);
      expect(conversationStore.findByEngineSession("session_99")).toBeNull();
    });

    it("setEngineSession() handles non-existent conversation", () => {
      expect(() => conversationStore.setEngineSession("invalid", "session")).not.toThrow();
    });

    it("clearEngineSession() handles non-existent conversation", () => {
      expect(() => conversationStore.clearEngineSession("invalid")).not.toThrow();
    });
  });

  describe("Persistence & Recovery", () => {
    it("survives re-initialization (persistence check)", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/persist", title: "Keep Me" });
      conversationStore.flushAll();

      // Clear memory and re-init
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();

      const recovered = conversationStore.get(conv.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.title).toBe("Keep Me");
    });

    it("handles corrupt index file gracefully", () => {
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, "{ invalid json", "utf-8");

      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      
      // Should not throw, just start fresh
      expect(() => conversationStore.init()).not.toThrow();
      expect(conversationStore.list().length).toBe(0);
    });

    it("handles version mismatch by rebuilding", () => {
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify({ version: 999, conversations: [] }), "utf-8");

      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      
      conversationStore.init();
      expect((conversationStore as any).index.size).toBe(0);
    });

    it("atomicWrite() handles write failures", () => {
      // Create a file where a directory should be to cause write error
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const msgPath = (conversationStore as any).getMessageFilePath(conv.id);
      fs.mkdirSync(msgPath, { recursive: true }); 
      
      // This should fail to write but not crash the process (it logs error)
      expect(() => (conversationStore as any).writeMessages(conv.id, [])).not.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("delete() handles non-existent conversation", () => {
      expect(() => conversationStore.delete("invalid")).not.toThrow();
    });

    it("update() handles non-existent conversation", () => {
      expect(() => conversationStore.update("invalid", { title: "foo" })).not.toThrow();
    });

    it("listMessages() handles corrupt message file", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const msgPath = (conversationStore as any).getMessageFilePath(conv.id);
      fs.mkdirSync(path.dirname(msgPath), { recursive: true });
      fs.writeFileSync(msgPath, "{ corrupt", "utf-8");

      expect(conversationStore.listMessages(conv.id)).toEqual([]);
    });

    it("getSteps() handles corrupt steps file", () => {
      const convId = "conv_1";
      const stepsPath = (conversationStore as any).getStepsFilePath(convId);
      fs.mkdirSync(path.dirname(stepsPath), { recursive: true });
      fs.writeFileSync(stepsPath, "{ corrupt", "utf-8");

      expect(conversationStore.getSteps(convId, "msg_1")).toEqual([]);
    });

    it("updateMessage() handles non-existent message", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      expect(() => conversationStore.updateMessage(conv.id, "invalid", { role: "assistant" })).not.toThrow();
    });
    
    it("truncateStepOutput() skips non-tool steps", () => {
      const step: any = { type: "text", text: "foo" };
      const result = (conversationStore as any).truncateStepOutput(step);
      expect(result).toBe(step);
    });

    it("truncateStepOutput() skips small tool outputs", () => {
      const step: any = { type: "tool", state: { status: "completed", output: "short" } };
      const result = (conversationStore as any).truncateStepOutput(step);
      expect(result).toBe(step);
    });
  });
});

