import fs from "fs";
import path from "path";
import os from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "electron";
import { conversationStore } from "../../../../electron/main/services/conversation-store";
import type { ConversationMessage, TextPart, UnifiedPart } from "../../../../src/types/unified";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
}));

vi.mock("../../../../electron/main/services/logger", () => ({
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
    (conversationStore as any).initialized = false;
    (conversationStore as any).index = new Map();
    (conversationStore as any).basePath = "";
    (conversationStore as any).indexDirty = false;
    (conversationStore as any).writeLocks = new Map();
    if ((conversationStore as any).indexTimer) {
      clearTimeout((conversationStore as any).indexTimer);
      (conversationStore as any).indexTimer = null;
    }
    vi.mocked(app.getPath).mockReturnValue(tmpDir);
    conversationStore.init();
  });

  afterEach(async () => {
    await conversationStore.flushAll();
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
    it("initializes directories and handles idempotency", () => {
      // init() creates the conversations directory
      const convDir = path.join(tmpDir, "conversations");
      expect(fs.existsSync(convDir)).toBe(true);
      expect(fs.statSync(convDir).isDirectory()).toBe(true);

      // init() is idempotent
      expect(() => conversationStore.init()).not.toThrow();
      expect((conversationStore as any).initialized).toBe(true);
    });

    it("requires initialization and manages pending index changes", async () => {
      // methods throw if called before init
      (conversationStore as any).initialized = false;
      expect(() => conversationStore.list()).toThrow("ConversationStore not initialized");

      // Re-init for flush test
      (conversationStore as any).initialized = true;

      // flushAll() writes pending index changes
      conversationStore.create({ engineType: "opencode", directory: "/test" });
      expect((conversationStore as any).indexDirty).toBe(true);
      await conversationStore.flushAll();
      expect((conversationStore as any).indexDirty).toBe(false);
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      expect(fs.existsSync(indexPath)).toBe(true);
    });
  });

  describe("Conversation CRUD", () => {
    it("creates conversations with metadata and handles retrieval", () => {
      // create() returns a ConversationMeta with correct fields
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

      // create() generates a default title if not provided
      const conv2 = conversationStore.create({
        engineType: "opencode",
        directory: "/test"
      });
      expect(conv2.title).toMatch(/^Chat \d+-\d+ \d+:\d+/);

      // get() returns the conversation or null
      expect(conversationStore.get(conv.id)).toEqual(conv);
      expect(conversationStore.get("non-existent")).toBeNull();
    });

    it("lists and filters conversations with path normalization", () => {
      const c1 = conversationStore.create({ engineType: "opencode", directory: "C:\\projects\\foo" });
      const now = Date.now();
      const c2 = conversationStore.create({ engineType: "claude", directory: "/projects/bar" });

      // list() returns all conversations sorted by updatedAt desc
      (c2 as any).updatedAt = now + 1000;
      conversationStore.update(c2.id, { updatedAt: now + 1000 });
      const list = conversationStore.list();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(c2.id);
      expect(list[1].id).toBe(c1.id);

      // list() filters by engineType
      const filteredByEngine = conversationStore.list({ engineType: "opencode" });
      expect(filteredByEngine.length).toBe(1);
      expect(filteredByEngine[0].engineType).toBe("opencode");

      // list() filters by directory (case-insensitive slash normalization)
      const filteredByDir = conversationStore.list({ directory: "C:/projects/foo" });
      expect(filteredByDir.length).toBe(1);
      expect(filteredByDir[0].directory).toBe("C:\\projects\\foo");
    });

    it("updates fields while preserving core attributes", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const oldUpdatedAt = conv.updatedAt;
      const originalId = conv.id;
      const originalCreatedAt = conv.createdAt;

      const future = Date.now() + 100;
      vi.useFakeTimers();
      vi.setSystemTime(future);

      // update() updates fields and updatedAt
      conversationStore.update(conv.id, { title: "New Title" });
      const updated = conversationStore.get(conv.id)!;
      expect(updated.title).toBe("New Title");
      expect(updated.updatedAt).toBe(future);
      expect(updated.updatedAt).toBeGreaterThan(oldUpdatedAt);

      // update() preserves id and createdAt
      conversationStore.update(conv.id, { id: "hacked", createdAt: 123 } as any);
      const afterHackAttempt = conversationStore.get(conv.id)!;
      expect(afterHackAttempt.id).toBe(originalId);
      expect(afterHackAttempt.createdAt).toBe(originalCreatedAt);

      vi.useRealTimers();
    });

    it("manages conversation deletion and renaming", async () => {
      // delete() removes from index and deletes files
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const id = conv.id;
      const msgPath = path.join(tmpDir, "conversations", `${id}.json`);
      const stepsPath = path.join(tmpDir, "conversations", `${id}.steps.json`);
      fs.mkdirSync(path.join(tmpDir, "conversations"), { recursive: true });
      fs.writeFileSync(msgPath, "[]");
      fs.writeFileSync(stepsPath, "{}");

      await conversationStore.delete(id);
      expect(conversationStore.get(id)).toBeNull();
      expect(fs.existsSync(msgPath)).toBe(false);
      expect(fs.existsSync(stepsPath)).toBe(false);

      // rename() is a shorthand for update({ title })
      const conv2 = conversationStore.create({ engineType: "opencode", directory: "/test2" });
      conversationStore.rename(conv2.id, "Renamed");
      expect(conversationStore.get(conv2.id)!.title).toBe("Renamed");
    });
  });

  describe("Messages", () => {
    const mockMsg: ConversationMessage = {
      id: "msg_1",
      role: "user",
      time: { created: Date.now() },
      parts: [{ type: "text", id: "part_1", messageId: "msg_1", sessionId: "s1", text: "Hello" } as TextPart]
    };

    it("manages message history and previews with content handling", async () => {
      // listMessages() returns empty array when no file exists
      expect(await conversationStore.listMessages("non-existent")).toEqual([]);

      // appendMessage() writes to disk and updates meta
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      await conversationStore.appendMessage(conv.id, mockMsg);
      const updatedConv = conversationStore.get(conv.id)!;
      expect(updatedConv.messageCount).toBe(1);
      expect(updatedConv.preview).toBe("Hello");
      expect(updatedConv.title).toBe("Hello");

      const messages = await conversationStore.listMessages(conv.id);
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe("msg_1");

      // First message with long text triggers auto-title truncation (50 chars + "...")
      const conv2 = conversationStore.create({ engineType: "opencode", directory: "/test2" });
      const longFirstMsg: ConversationMessage = {
        ...mockMsg,
        id: "msg_long_first",
        parts: [{ type: "text", id: "p1", messageId: "msg_long_first", sessionId: "s1", text: "B".repeat(200) } as TextPart]
      };
      await conversationStore.appendMessage(conv2.id, longFirstMsg);
      const conv2Updated = conversationStore.get(conv2.id)!;
      expect(conv2Updated.title.length).toBe(53);
      expect(conv2Updated.title.endsWith("...")).toBe(true);

      // appendMessage() handles long previews (title only auto-set on first message)
      const longText = "A".repeat(200);
      const longMsg: ConversationMessage = {
        ...mockMsg,
        id: "msg_long",
        parts: [{ type: "text", id: "p1", messageId: "msg_long", sessionId: "s1", text: longText } as TextPart]
      };
      await conversationStore.appendMessage(conv.id, longMsg);
      const updatedLong = conversationStore.get(conv.id)!;
      expect(updatedLong.preview?.length).toBe(103);
      expect(updatedLong.preview?.endsWith("...")).toBe(true);
      // Title stays as "Hello" from first message — auto-title only applies on messages.length === 1
      expect(updatedLong.title).toBe("Hello");
    });

    it("updates existing messages in history", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      await conversationStore.appendMessage(conv.id, mockMsg);
      await conversationStore.updateMessage(conv.id, "msg_1", { role: "assistant" });
      const messages = await conversationStore.listMessages(conv.id);
      expect(messages[0].role).toBe("assistant");
    });
  });

  describe("Steps", () => {
    it("manages reasoning steps with output truncation for large content", async () => {
      const convId = "conv_123";
      const mockSteps: UnifiedPart[] = [
        { type: "text", id: "s1", messageId: "m1", sessionId: "s1", text: "step 1" } as any
      ];

      // getSteps() returns empty array when no steps file
      expect(await conversationStore.getSteps("id", "msgId")).toEqual([]);

      // saveSteps() and getSteps() roundtrip
      await conversationStore.saveSteps(convId, "msg_1", mockSteps);
      const saved = await conversationStore.getSteps(convId, "msg_1");
      expect(saved).toEqual(mockSteps);
      const allSteps = await conversationStore.getAllSteps(convId);
      expect(allSteps?.messages["msg_1"]).toEqual(mockSteps);

      // saveSteps() truncates large tool output
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
      await conversationStore.saveSteps(convId, "msg_large", [toolStep]);
      const savedLarge = (await conversationStore.getSteps(convId, "msg_large"))[0] as any;
      expect(savedLarge.state.output.length).toBeLessThan(largeOutput.length);
      expect(savedLarge.state.output).toContain("[truncated");
    });
  });

  describe("Project Derivation", () => {
    it("derives distinct projects from conversation directories", () => {
      conversationStore.create({ engineType: "opencode", directory: "/work/project-a" });
      conversationStore.create({ engineType: "opencode", directory: "/work/project-a" });
      conversationStore.create({ engineType: "claude", directory: "/work/project-a" });
      conversationStore.create({ engineType: "opencode", directory: "/work/project-b" });
      conversationStore.create({ engineType: "opencode", directory: "" });
      conversationStore.create({ engineType: "opencode", directory: "/" });

      const projects = conversationStore.deriveProjects();
      // Projects are now grouped by directory only (engine-agnostic)
      expect(projects.length).toBe(2);
      const names = projects.map(p => p.name).sort();
      expect(names).toEqual(["project-a", "project-b"]);
      const ids = projects.map(p => p.id).sort();
      expect(ids).toContain("dir-/work/project-a");
      expect(ids).toContain("dir-/work/project-b");
    });
  });

  describe("Engine Session Association", () => {
    it("manages mappings between store conversations and engine sessions", () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });

      // setEngineSession() and findByEngineSession() work correctly
      conversationStore.setEngineSession(conv.id, "session_99", { model: "gpt-4" });
      const found = conversationStore.findByEngineSession("session_99");
      expect(found?.id).toBe(conv.id);
      expect(found?.engineMeta?.model).toBe("gpt-4");

      // clearEngineSession() handles removal
      conversationStore.clearEngineSession(conv.id);
      expect(conversationStore.findByEngineSession("session_99")).toBeNull();

      // handles non-existent conversations gracefully
      expect(() => conversationStore.setEngineSession("invalid", "session")).not.toThrow();
      expect(() => conversationStore.clearEngineSession("invalid")).not.toThrow();
    });
  });

  describe("Persistence & Recovery", () => {
    it("recovers state from disk and handles corruption or version mismatches", async () => {
      // survives re-initialization (persistence check)
      const conv = conversationStore.create({ engineType: "opencode", directory: "/persist", title: "Keep Me" });
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();
      const recovered = conversationStore.get(conv.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.title).toBe("Keep Me");

      // handles corrupt index file gracefully
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      fs.writeFileSync(indexPath, "{ invalid json", "utf-8");
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      expect(() => conversationStore.init()).not.toThrow();
      expect(conversationStore.list().length).toBe(0);

      // handles version mismatch by rebuilding
      fs.writeFileSync(indexPath, JSON.stringify({ version: 999, conversations: [] }), "utf-8");
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();
      expect((conversationStore as any).index.size).toBe(0);
    });

    it("ensures atomic writes even on failures", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const msgPath = (conversationStore as any).getMessageFilePath(conv.id);
      fs.mkdirSync(msgPath, { recursive: true }); // Make it a directory to force write failure
      await expect((conversationStore as any).writeMessages(conv.id, [])).resolves.not.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("handles operations on missing conversations and corrupt message files", async () => {
      // handles non-existent conversation during delete/update
      await expect(conversationStore.delete("invalid")).resolves.not.toThrow();
      expect(() => conversationStore.update("invalid", { title: "foo" })).not.toThrow();

      // listMessages() handles corrupt message file
      const conv = conversationStore.create({ engineType: "opencode", directory: "/corrupt-test" });
      const msgPath = (conversationStore as any).getMessageFilePath(conv.id);
      fs.mkdirSync(path.dirname(msgPath), { recursive: true });
      fs.writeFileSync(msgPath, "{ corrupt", "utf-8");
      expect(await conversationStore.listMessages(conv.id)).toEqual([]);

      // updateMessage() handles non-existent message
      await expect(conversationStore.updateMessage(conv.id, "invalid", { role: "assistant" })).resolves.not.toThrow();
    });

    it("handles corrupt step files and manages step output truncation rules", async () => {
      // getSteps() handles corrupt steps file
      const convId = "conv_corrupt";
      const stepsPath = (conversationStore as any).getStepsFilePath(convId);
      fs.mkdirSync(path.dirname(stepsPath), { recursive: true });
      fs.writeFileSync(stepsPath, "{ corrupt", "utf-8");
      expect(await conversationStore.getSteps(convId, "msg_1")).toEqual([]);

      // truncateStepOutput rules
      const textStep: any = { type: "text", text: "foo" };
      expect((conversationStore as any).truncateStepOutput(textStep)).toBe(textStep);

      const smallToolStep: any = { type: "tool", state: { status: "completed", output: "short" } };
      expect((conversationStore as any).truncateStepOutput(smallToolStep)).toBe(smallToolStep);
    });
  });
});
