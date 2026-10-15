import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "electron";
import { conversationStore, makeCatalogProjectId } from "../../../../electron/main/services/conversation-store";
import type { ConversationMessage, EngineCatalogSnapshot, TextPart, UnifiedPart, UnifiedSession } from "../../../../src/types/unified";

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

  describe("migrateCodexConversations", () => {
    const threadId = "01a13ef6-bc2d-7030-8e3b-76c50f20d412";
    const sourceId = "codex-desktop:local:migration-fixture";
    const options = () => ({ sourceId, codexHome: path.join(tmpDir, "codex-home") });
    const message = (id: string, conversationId: string, text: string, created: number): ConversationMessage => ({
      id, role: "assistant", time: { created, completed: created + 1 },
      parts: [{ id: `${id}:part`, messageId: id, sessionId: conversationId, type: "text", text }],
    });
    const reload = async () => {
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();
    };

    it("consolidates one native thread while retaining legacy IDs, source metadata, and recovery files", async () => {
      const local = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(local.id, `codex_${threadId}`, { codexThreadId: threadId });
      conversationStore.setCustomTitle(local.id, "Local title");
      const desktop = conversationStore.create({
        engineType: "codex-desktop", directory: "/project", catalogSourceId: sourceId,
        projectId: makeCatalogProjectId("codex-desktop", sourceId, "native-project"),
      });
      conversationStore.update(desktop.id, { imported: true, engineMeta: { nativeDeleteEligible: false, desktopHostId: "local" }, archived: true });
      conversationStore.setEngineSession(desktop.id, threadId);
      const oldMessage = message(`msg_codex:codex_${threadId}:turn-1:assistant`, local.id, "final", 10);
      const nativeMessage = message(`codex-desktop:v1:local:${threadId}:turn-1:item:answer`, desktop.id, "A more complete final", 10);
      const earlierMessage = message(`msg_codex:codex_${threadId}:turn-0:assistant`, local.id, "Earlier turn", 1);
      await conversationStore.appendMessage(local.id, earlierMessage);
      await conversationStore.appendMessage(local.id, oldMessage);
      await conversationStore.appendMessage(desktop.id, nativeMessage);
      await conversationStore.saveSteps(desktop.id, nativeMessage.id, [{
        id: "reasoning", messageId: nativeMessage.id, sessionId: desktop.id, type: "reasoning", text: "Native reasoning",
      }]);

      await conversationStore.migrateCodexConversations(options());
      expect(conversationStore.list().map(conversation => conversation.id)).toEqual([local.id]);
      expect(conversationStore.get(desktop.id)).toMatchObject({
        id: local.id, engineType: "codex", engineSessionId: threadId, customTitle: "Local title", archived: true,
        catalogSourceId: sourceId, projectId: makeCatalogProjectId("codex", sourceId, "native-project"),
        engineMeta: { codexThreadId: threadId, nativeDeleteEligible: false, codexDesktopOwner: "codemux" },
      });
      expect(conversationStore.getConversationIds(local.id)).toEqual([local.id, desktop.id]);
      expect(conversationStore.resolveConversationId(desktop.id)).toBe(local.id);
      expect(conversationStore.findByEngineSession(`codex_${threadId}`, "codex-desktop", sourceId)?.id).toBe(local.id);
      expect((await conversationStore.listMessages(desktop.id)).map(entry => entry.id)).toEqual([earlierMessage.id, nativeMessage.id]);
      expect((await conversationStore.getSteps(desktop.id, nativeMessage.id))[0].sessionId).toBe(local.id);
      expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "conversations", `${desktop.id}.json`), "utf8"))).toEqual([nativeMessage]);
      const recovery = path.join(tmpDir, "conversations", "migrations", "codex-unified-v1");
      expect(JSON.parse(fs.readFileSync(path.join(recovery, `${local.id}.json`), "utf8"))).toEqual([earlierMessage, oldMessage]);

      const diskBefore = fs.readFileSync(path.join(tmpDir, "conversations", "index.json"), "utf8");
      await reload();
      await conversationStore.migrateCodexConversations(options());
      expect(fs.readFileSync(path.join(tmpDir, "conversations", "index.json"), "utf8")).toBe(diskBefore);
      expect(conversationStore.getConversationIds(desktop.id)).toEqual([local.id, desktop.id]);
      conversationStore.setCustomTitle(desktop.id, "Alias rename");
      expect(conversationStore.get(local.id)?.customTitle).toBe("Alias rename");
      await conversationStore.delete(desktop.id);
      expect(conversationStore.get(local.id)?.engineSessionId).toBe(threadId);
      expect(conversationStore.isConversationAlias(desktop.id)).toBe(false);
    });

    it("keeps different sources and other engines separate without enrolling historical sessions", async () => {
      const local = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(local.id, `codex_${threadId}`);
      const otherHome = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(otherHome.id, `codex_${threadId}`, { codexHome: path.join(tmpDir, "another-home") });
      const otherSource = conversationStore.create({ engineType: "codex-desktop", directory: "/project", catalogSourceId: "remote-source" });
      conversationStore.setEngineSession(otherSource.id, threadId);
      const claude = conversationStore.create({ engineType: "claude", directory: "/project" });
      conversationStore.setEngineSession(claude.id, `codex_${threadId}`, { sourceId });
      const unchangedClaude = structuredClone(claude);
      await conversationStore.migrateCodexConversations(options());
      expect(conversationStore.list()).toHaveLength(4);
      expect(conversationStore.get(local.id)?.catalogSourceId).toBeUndefined();
      expect(conversationStore.get(otherSource.id)?.engineMeta?.codexDesktopOwner).toBeUndefined();
      expect(conversationStore.get(claude.id)).toEqual(unchangedClaude);
      expect(conversationStore.list({ engineType: "codex-desktop" })).toHaveLength(3);
    });

    it("preserves an observed final answer when another projection only has longer progress text", async () => {
      const local = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(local.id, `codex_${threadId}`);
      const desktop = conversationStore.create({ engineType: "codex-desktop", directory: "/project" });
      conversationStore.update(desktop.id, { imported: true });
      conversationStore.setEngineSession(desktop.id, threadId);
      const final = message(`msg_codex:codex_${threadId}:turn-1:assistant`, local.id, "Complete final answer", 1);
      (final.parts[0] as TextPart).phase = "final";
      const partial = message(`codex-desktop:v1:local:${threadId}:turn-1:item:progress`, desktop.id, "Long progress ".repeat(100), 1);
      (partial.parts[0] as TextPart).phase = "commentary";
      await conversationStore.appendMessage(local.id, final);
      await conversationStore.appendMessage(desktop.id, partial);
      await conversationStore.migrateCodexConversations(options());
      expect(await conversationStore.listMessages(local.id)).toEqual([final]);
    });

    it("migrates native catalog identities and local suppression without resurrecting another projection", async () => {
      const desktop = conversationStore.create({ engineType: "codex-desktop", directory: "/project" });
      conversationStore.setEngineSession(desktop.id, threadId);
      await conversationStore.removeEngineConversation(desktop.id, "local");
      const local = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(local.id, `codex_${threadId}`);
      const remote = conversationStore.create({ engineType: "codex-desktop", directory: "/project", catalogSourceId: "remote-source" });
      conversationStore.setEngineSession(remote.id, threadId);
      const claudeRemoved = conversationStore.create({ engineType: "claude", directory: "/project" });
      conversationStore.setEngineSession(claudeRemoved.id, "claude-native");
      await conversationStore.removeEngineConversation(claudeRemoved.id, "local");
      const claudeRetained = conversationStore.create({ engineType: "claude", directory: "/project" });
      conversationStore.setEngineSession(claudeRetained.id, "claude-native");
      conversationStore.upsertCatalog("codex-desktop", {
        engineType: "codex-desktop", sourceId, revision: "1", complete: true,
        projects: [{ id: "native-project", name: "Native project", directory: "/project", engineMeta: { nativeDeleteEligible: false } }],
        sessions: [],
      });
      await conversationStore.migrateCodexConversations(options());
      expect(conversationStore.list().map(conversation => conversation.id).sort()).toEqual([remote.id, claudeRetained.id].sort());
      expect(conversationStore.isSessionSuppressed("codex", threadId, sourceId)).toBe(true);
      expect(conversationStore.isSessionSuppressed("codex-desktop", `codex_${threadId}`, sourceId)).toBe(true);
      expect(conversationStore.isSessionSuppressed("codex", threadId, "remote-source")).toBe(false);
      expect(conversationStore.listCatalogs()[0]).toMatchObject({ engineType: "codex", sourceId });
      expect(conversationStore.getCatalogProject(makeCatalogProjectId("codex-desktop", sourceId, "native-project"))).toMatchObject({
        id: makeCatalogProjectId("codex", sourceId, "native-project"), engineType: "codex", catalogProjectId: "native-project",
        engineMeta: { nativeDeleteEligible: false },
      });
      await reload();
      expect(conversationStore.list().map(conversation => conversation.id).sort()).toEqual([remote.id, claudeRetained.id].sort());
      expect(conversationStore.isSessionSuppressed("codex", threadId, sourceId)).toBe(true);
    });

    it("does not publish aliases when a duplicate history cannot be read", async () => {
      const first = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(first.id, `codex_${threadId}`);
      const second = conversationStore.create({ engineType: "codex-desktop", directory: "/project" });
      conversationStore.setEngineSession(second.id, threadId);
      fs.writeFileSync(path.join(tmpDir, "conversations", `${second.id}.json`), "invalid history");
      await expect(conversationStore.migrateCodexConversations(options())).rejects.toThrow();
      expect(conversationStore.list()).toHaveLength(2);
      expect(conversationStore.get(first.id)?.engineSessionId).toBe(`codex_${threadId}`);
      expect(conversationStore.isConversationAlias(second.id)).toBe(false);
      const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "conversations", "index.json"), "utf8"));
      expect(saved.codexMigrationVersion).toBeUndefined();
      const repaired = message("repaired-message", second.id, "Recovered history", 1);
      fs.writeFileSync(path.join(tmpDir, "conversations", `${second.id}.json`), JSON.stringify([repaired]));
      await conversationStore.migrateCodexConversations(options());
      expect(conversationStore.list()).toHaveLength(1);
      expect((await conversationStore.listMessages(first.id)).map(entry => entry.id)).toEqual([repaired.id]);
    });

    it("retries an interrupted projection write from its validated originals before publishing aliases", async () => {
      const local = conversationStore.create({ engineType: "codex", directory: "/project" });
      conversationStore.setEngineSession(local.id, `codex_${threadId}`);
      const desktop = conversationStore.create({ engineType: "codex-desktop", directory: "/project" });
      conversationStore.setEngineSession(desktop.id, threadId);
      conversationStore.update(desktop.id, { imported: true });
      const first = message("first-message", local.id, "First", 1);
      const second = message("second-message", desktop.id, "Second", 2);
      await conversationStore.appendMessage(local.id, first);
      await conversationStore.appendMessage(desktop.id, second);
      await conversationStore.flushAll();
      const indexPath = path.join(tmpDir, "conversations", "index.json");
      const oldIndex = fs.readFileSync(indexPath, "utf8");
      const rename = fsp.rename.bind(fsp);
      const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === indexPath) throw new Error("Index publication unavailable");
        await rename(from, to);
      });
      try {
        await expect(conversationStore.migrateCodexConversations(options())).rejects.toThrow("Index publication unavailable");
      } finally {
        spy.mockRestore();
      }
      expect(conversationStore.list()).toHaveLength(2);
      expect(conversationStore.isConversationAlias(desktop.id)).toBe(false);
      expect(fs.readFileSync(indexPath, "utf8")).toBe(oldIndex);
      await conversationStore.migrateCodexConversations(options());
      expect(conversationStore.list()).toHaveLength(1);
      expect((await conversationStore.listMessages(local.id)).map(entry => entry.id)).toEqual([first.id, second.id]);
      expect(conversationStore.resolveConversationId(desktop.id)).toBe(local.id);
    });
  });

  describe("Conversation CRUD", () => {
    it("creates conversations with metadata and handles retrieval", () => {
      // create() returns a ConversationMeta with correct fields.
      // Titles are derived at render time from customTitle/engineTitle/firstPrompt.
      const conv = conversationStore.create({
        engineType: "claude",
        directory: "/projects/foo",
      });
      expect(conv.id).toMatch(/^conv_/);
      expect(conv.engineType).toBe("claude");
      expect(conv.directory).toBe("/projects/foo");
      expect(conv).not.toHaveProperty("title");
      expect(conv.customTitle).toBeUndefined();
      expect(conv.engineTitle).toBeUndefined();
      expect(conv.createdAt).toBeLessThanOrEqual(Date.now());
      expect(conv.updatedAt).toBe(conv.createdAt);
      expect(conv.messageCount).toBe(0);

      // setCustomTitle() overrides displayTitle on the wire layer
      conversationStore.setCustomTitle(conv.id, "My Project");
      expect(conversationStore.get(conv.id)!.customTitle).toBe("My Project");

      // get() returns the conversation or null
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

      // setCustomTitle() persists user-set title
      const conv2 = conversationStore.create({ engineType: "opencode", directory: "/test2" });
      conversationStore.setCustomTitle(conv2.id, "Renamed");
      expect(conversationStore.get(conv2.id)!.customTitle).toBe("Renamed");
    });

    it("updates persisted session config fields without touching unrelated metadata", () => {
      const conv = conversationStore.create({
        engineType: "opencode",
        directory: "/test",
      });
      conversationStore.setCustomTitle(conv.id, "Pinned title");

      const updated = conversationStore.updateSessionConfig(conv.id, {
        mode: "plan",
        modelId: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
      });

      expect(updated).toMatchObject({
        id: conv.id,
        customTitle: "Pinned title",
        mode: "plan",
        modelId: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
      });

      const cleared = conversationStore.updateSessionConfig(conv.id, {
        reasoningEffort: null,
        serviceTier: null,
      });

      expect(cleared?.reasoningEffort).toBeUndefined();
      expect(cleared?.serviceTier).toBeUndefined();
      expect(cleared?.mode).toBe("plan");
      expect(cleared?.modelId).toBe("gpt-5.4");

      expect(
        conversationStore.updateSessionConfig("missing", { mode: "agent" }),
      ).toBeNull();
    });
  });

  describe("setArchived", () => {
    it("archives and restores conversations without deleting their metadata or history", async () => {
      const conv = conversationStore.create({
        engineType: "claude",
        directory: "/test",
        worktreeId: "test-worktree",
        parentDirectory: "/parent",
      });
      const other = conversationStore.create({ engineType: "opencode", directory: "/other" });
      const message: ConversationMessage = {
        id: "archived-message",
        role: "user",
        time: { created: 1 },
        parts: [{
          type: "text",
          id: "archived-text",
          messageId: "archived-message",
          sessionId: conv.id,
          text: "Keep this conversation",
        }],
      };
      const steps: UnifiedPart[] = [{
        type: "reasoning",
        id: "archived-reasoning",
        messageId: message.id,
        sessionId: conv.id,
        text: "Keep these steps",
      }];
      await conversationStore.appendMessage(conv.id, message);
      await conversationStore.saveSteps(conv.id, message.id, steps);
      conversationStore.setCustomTitle(conv.id, "Saved title");
      conversationStore.setEngineSession(conv.id, "engine-session", { source: "test" });
      conversationStore.updateSessionConfig(conv.id, { mode: "plan", modelId: "test-model" });
      const { updatedAt: _updatedAt, ...preservedMeta } = conv;

      for (const archived of [true, false]) {
        conversationStore.setArchived(conv.id, archived);
        await conversationStore.flushAll();
        (conversationStore as any).initialized = false;
        (conversationStore as any).index = new Map();
        conversationStore.init();

        expect(conversationStore.get(conv.id)).toMatchObject({ ...preservedMeta, archived });
        expect(conversationStore.list().map((entry) => entry.id).sort()).toEqual([conv.id, other.id].sort());
        expect(conversationStore.list({ engineType: "claude", directory: "/test" }).map((entry) => entry.id)).toEqual([conv.id]);
        expect(await conversationStore.listMessages(conv.id)).toEqual([message]);
        expect(await conversationStore.getSteps(conv.id, message.id)).toEqual(steps);
      }
    });

    it.each([true, false])("rejects an unknown conversation when archived is %s", (archived) => {
      expect(() => conversationStore.setArchived("missing-conversation", archived)).toThrow();
      expect(conversationStore.get("missing-conversation")).toBeNull();
      expect(conversationStore.list()).toEqual([]);
    });
  });

  describe("create", () => {
    it.each([
      { name: "omitted", flag: {} },
      { name: "true", flag: { archived: true } },
      { name: "false", flag: { archived: false } },
    ])("preserves the $name initial archive state", async ({ flag }) => {
      const conv = conversationStore.create({ engineType: "claude", directory: "/test", ...flag });

      if ("archived" in flag) {
        expect(conv).toHaveProperty("archived", flag.archived);
      } else {
        expect(conv).not.toHaveProperty("archived");
      }
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();

      const restored = conversationStore.get(conv.id);
      if ("archived" in flag) {
        expect(restored).toHaveProperty("archived", flag.archived);
      } else {
        expect(restored).not.toHaveProperty("archived");
      }
      expect(conversationStore.list().map((entry) => entry.id)).toEqual([conv.id]);
    });
  });

  describe("importConversation", () => {
    it.each([
      { name: "omitted", flag: {} },
      { name: "true", flag: { archived: true } },
      { name: "false", flag: { archived: false } },
    ])("preserves the $name initial archive state", async ({ flag }) => {
      const message: ConversationMessage = {
        id: "imported-message",
        role: "assistant",
        time: { created: 1 },
        parts: [{
          type: "text",
          id: "imported-text",
          messageId: "imported-message",
          sessionId: "engine-session",
          text: "Imported answer",
        }],
      };
      const step: UnifiedPart = {
        type: "reasoning",
        id: "imported-reasoning",
        messageId: message.id,
        sessionId: "engine-session",
        text: "Imported steps",
      };
      const conv = await conversationStore.importConversation({
        engineType: "claude",
        directory: "/test",
        title: "Imported conversation",
        createdAt: 1,
        updatedAt: 2,
        engineSessionId: "engine-session",
        messages: [message],
        steps: { [message.id]: [step] },
        ...flag,
      });

      if ("archived" in flag) {
        expect(conv).toHaveProperty("archived", flag.archived);
      } else {
        expect(conv).not.toHaveProperty("archived");
      }
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();

      const restored = conversationStore.get(conv.id);
      if ("archived" in flag) {
        expect(restored).toHaveProperty("archived", flag.archived);
      } else {
        expect(restored).not.toHaveProperty("archived");
      }
      expect(restored).toMatchObject({ imported: true, messageCount: 1, engineSessionId: "engine-session" });
      expect(conversationStore.list().map((entry) => entry.id)).toEqual([conv.id]);
      expect(await conversationStore.listMessages(conv.id)).toEqual([{
        ...message,
        parts: message.parts.map((part) => ({ ...part, sessionId: conv.id })),
      }]);
      expect(await conversationStore.getSteps(conv.id, message.id)).toEqual([{ ...step, sessionId: conv.id }]);
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
      // First user message captures firstPrompt fallback
      expect(updatedConv.firstPrompt).toBe("Hello");
      // No title is auto-set anymore — displayTitle is derived at render time
      expect(updatedConv.title).toBeUndefined();
      expect(updatedConv.customTitle).toBeUndefined();
      expect(updatedConv.engineTitle).toBeUndefined();

      const messages = await conversationStore.listMessages(conv.id);
      expect(messages.length).toBe(1);
      expect(messages[0].id).toBe("msg_1");

      // First message with long text triggers firstPrompt truncation (100 chars + "…")
      const conv2 = conversationStore.create({ engineType: "opencode", directory: "/test2" });
      const longFirstMsg: ConversationMessage = {
        ...mockMsg,
        id: "msg_long_first",
        parts: [{ type: "text", id: "p1", messageId: "msg_long_first", sessionId: "s1", text: "B".repeat(200) } as TextPart]
      };
      await conversationStore.appendMessage(conv2.id, longFirstMsg);
      const conv2Updated = conversationStore.get(conv2.id)!;
      expect(conv2Updated.firstPrompt!.length).toBe(101);
      expect(conv2Updated.firstPrompt!.endsWith("…")).toBe(true);

      // appendMessage() handles long previews (firstPrompt only set on first message)
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
      // firstPrompt stays as "Hello" from first message
      expect(updatedLong.firstPrompt).toBe("Hello");
    });

    it("updates existing messages in history", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      await conversationStore.appendMessage(conv.id, mockMsg);
      await conversationStore.updateMessage(conv.id, "msg_1", { role: "assistant" });
      const messages = await conversationStore.listMessages(conv.id);
      expect(messages[0].role).toBe("assistant");
    });
  });

  describe("removeMessage", () => {
    const makeMessage = (id: string, text?: string): ConversationMessage => ({
      id,
      role: "assistant",
      time: { created: 1 },
      parts: text === undefined ? [] : [{
        type: "text",
        id: `${id}-text`,
        messageId: id,
        sessionId: "session-1",
        text,
      }],
    });
    const makeSteps = (messageId: string): UnifiedPart[] => [{
      type: "reasoning",
      id: `${messageId}-reasoning`,
      messageId,
      sessionId: "session-1",
      text: "Working through the request",
    }];

    it("removes persisted messages and their steps while retaining unrelated entries", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const first = makeMessage("first", "First answer");
      const removed = makeMessage("removed", "Removed answer");
      const last = makeMessage("last", "Last answer");
      for (const message of [first, removed, last]) {
        await conversationStore.appendMessage(conv.id, message);
        await conversationStore.saveSteps(conv.id, message.id, makeSteps(message.id));
      }

      await conversationStore.removeMessage(conv.id, removed.id);
      await conversationStore.flushAll();

      const basePath = path.join(tmpDir, "conversations");
      const persistedMessages = JSON.parse(fs.readFileSync(path.join(basePath, `${conv.id}.json`), "utf-8"));
      const persistedSteps = JSON.parse(fs.readFileSync(path.join(basePath, `${conv.id}.steps.json`), "utf-8"));
      const persistedIndex = JSON.parse(fs.readFileSync(path.join(basePath, "index.json"), "utf-8"));
      expect(persistedMessages).toEqual([first, last]);
      expect(persistedSteps.messages).toEqual({
        first: makeSteps(first.id),
        last: makeSteps(last.id),
      });
      expect(persistedIndex.conversations).toEqual([
        expect.objectContaining({ id: conv.id, messageCount: 2, preview: "Last answer" }),
      ]);
    });

    it.each([
      {
        name: "restores the previous text preview and truncates it after removing the last text message",
        messages: [makeMessage("first", "A".repeat(120)), makeMessage("empty"), makeMessage("removed", "Remove me")],
        expectedPreview: "A".repeat(100) + "...",
      },
      {
        name: "clears the preview after removing the only message",
        messages: [makeMessage("removed", "Remove me")],
        expectedPreview: undefined,
      },
      {
        name: "clears the preview when the remaining messages have no text",
        messages: [makeMessage("empty"), makeMessage("removed", "Remove me")],
        expectedPreview: undefined,
      },
    ])("$name", async ({ messages, expectedPreview }) => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      for (const message of messages) {
        await conversationStore.appendMessage(conv.id, message);
      }

      await conversationStore.removeMessage(conv.id, "removed");

      expect(await conversationStore.listMessages(conv.id)).toEqual(
        messages.filter((message) => message.id !== "removed"),
      );
      expect(conversationStore.get(conv.id)?.messageCount).toBe(messages.length - 1);
      expect(conversationStore.get(conv.id)?.preview).toBe(expectedPreview);
    });

    it("cleans orphaned steps and leaves repeated or missing removals unchanged", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      await conversationStore.saveSteps(conv.id, "orphan", makeSteps("orphan"));
      await conversationStore.saveSteps(conv.id, "retained", makeSteps("retained"));

      await conversationStore.removeMessage(conv.id, "orphan");
      conversationStore.update(conv.id, { updatedAt: 1 });
      await conversationStore.removeMessage(conv.id, "orphan");
      await conversationStore.removeMessage("missing-conversation", "orphan");

      expect((await conversationStore.getAllSteps(conv.id))?.messages).toEqual({
        retained: makeSteps("retained"),
      });
      expect(conversationStore.get(conv.id)).toMatchObject({ messageCount: 0, updatedAt: 1 });
      expect(conversationStore.get(conv.id)?.preview).toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, "conversations", `${conv.id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "conversations", "missing-conversation.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "conversations", "missing-conversation.steps.json"))).toBe(false);
    });

    it("waits for earlier message and step writes before removing their results", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const removed = makeMessage("removed", "Remove me");

      await Promise.all([
        conversationStore.appendMessage(conv.id, removed),
        conversationStore.saveSteps(conv.id, removed.id, makeSteps(removed.id)),
        conversationStore.removeMessage(conv.id, removed.id),
      ]);

      expect(await conversationStore.listMessages(conv.id)).toEqual([]);
      expect((await conversationStore.getAllSteps(conv.id))?.messages).toEqual({});
      expect(conversationStore.get(conv.id)?.messageCount).toBe(0);
      expect(conversationStore.get(conv.id)?.preview).toBeUndefined();
    });

    it("preserves message writes queued after removal", async () => {
      const conv = conversationStore.create({ engineType: "opencode", directory: "/test" });
      const removed = makeMessage("removed", "Old answer");
      const replacement = makeMessage("removed", "Replacement answer");
      const later = makeMessage("later", "Later answer");
      await conversationStore.appendMessage(conv.id, removed);
      await conversationStore.saveSteps(conv.id, removed.id, makeSteps(removed.id));

      await Promise.all([
        conversationStore.removeMessage(conv.id, removed.id),
        conversationStore.ensureMessage(conv.id, replacement),
        conversationStore.updateMessage(conv.id, replacement.id, { modelId: "test-model" }),
        conversationStore.appendMessage(conv.id, later),
      ]);

      expect(await conversationStore.listMessages(conv.id)).toEqual([
        { ...replacement, modelId: "test-model" },
        later,
      ]);
      expect(await conversationStore.getSteps(conv.id, removed.id)).toEqual([]);
      expect(conversationStore.get(conv.id)).toMatchObject({ messageCount: 2, preview: "Later answer" });
    });
  });

  describe("Steps", () => {
    it("manages reasoning steps with output truncation for large content", async () => {
      const convId = conversationStore.create({ engineType: "opencode", directory: "/test" }).id;
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

  describe("removeEngineConversation", () => {
    const nativeId = "removed-native";
    const sourceId = "removal-source";
    const message: ConversationMessage = {
      id: "saved-message", role: "assistant", time: { created: 1 },
      parts: [{ type: "text", id: "saved-text", messageId: "saved-message", sessionId: nativeId, text: "Stored answer" }],
    };
    const steps: UnifiedPart[] = [{
      type: "reasoning", id: "saved-reasoning", messageId: message.id, sessionId: nativeId, text: "Stored reasoning",
    }];

    function catalog(owner = sourceId, engineType: UnifiedSession["engineType"] = "codex-desktop"): EngineCatalogSnapshot {
      return {
        sourceId: owner, revision: "active", complete: true, projects: [],
        sessions: [{ id: nativeId, engineType, directory: "/test", title: "Native title", archived: false, time: { created: 1, updated: 2 } }],
      };
    }

    function importParams() {
      return {
        engineType: "codex-desktop" as const, directory: "/test", title: "Fresh imported title",
        createdAt: 1, updatedAt: 3, engineSessionId: nativeId, catalogSourceId: sourceId,
        archived: false, messages: [message], steps: { [message.id]: steps },
      };
    }

    async function restart() {
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();
    }

    function filePath(id: string, suffix = ".json") {
      return path.join(tmpDir, "conversations", id + suffix);
    }

    function persistedRemovals() {
      return JSON.parse(fs.readFileSync(filePath("index"), "utf8")).removals;
    }

    it.each(["local", "archived"] as const)("persists only identity removal data for %s and hides refreshed catalog entries", async (kind) => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      conversationStore.setCustomTitle(id, "Local private title");
      if (kind === "archived") {
        await conversationStore.appendMessage(id, message);
        await conversationStore.saveSteps(id, message.id, steps);
      }

      const pending = conversationStore.removeEngineConversation(id, kind, sourceId);
      expect(conversationStore.get(id)).toBeNull();
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(true);
      expect(conversationStore.upsertCatalog("codex-desktop", catalog()).sessions).toEqual([]);
      await pending;

      expect(persistedRemovals()).toEqual([{
        engineType: "codex-desktop", sourceId, engineSessionId: nativeId, conversationId: id, kind,
      }]);
      for (const suffix of [".json", ".json.tmp", ".steps.json", ".steps.json.tmp"]) {
        expect(fs.existsSync(filePath(id, suffix))).toBe(false);
      }
      await restart();
      expect(conversationStore.list()).toEqual([]);
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(true);
      expect(conversationStore.upsertCatalog("codex-desktop", catalog()).sessions).toEqual([]);
    });

    it("keeps source and engine identities separate while matching unscoped legacy removals", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      const other = conversationStore.upsertCatalog("codex-desktop", catalog("another-source")).sessions[0].id;
      const otherEngine = conversationStore.upsertCatalog("copilot", catalog(sourceId, "copilot")).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "local", sourceId);

      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId)).toBe(false);
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, "another-source")).toBe(false);
      expect(conversationStore.isSessionSuppressed("copilot", nativeId, sourceId)).toBe(false);
      expect(conversationStore.get(other)?.id).toBe(other);
      expect(conversationStore.get(otherEngine)?.id).toBe(otherEngine);

      const legacy = conversationStore.create({ engineType: "claude", directory: "/test" });
      conversationStore.setEngineSession(legacy.id, nativeId);
      await conversationStore.removeEngineConversation(legacy.id, "local");
      await restart();
      expect(conversationStore.isSessionSuppressed("claude", nativeId)).toBe(true);
      expect(conversationStore.isSessionSuppressed("claude", nativeId, sourceId)).toBe(true);
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId)).toBe(false);
    });

    it("never bypasses local suppression during explicit reimport", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "local", sourceId);
      await expect(conversationStore.importConversation(importParams())).rejects.toThrow("suppressed");
      await expect(conversationStore.importConversation({ ...importParams(), restoreArchived: true })).rejects.toThrow("suppressed");
      expect(conversationStore.list()).toEqual([]);
      expect(fs.existsSync(filePath(id))).toBe(false);
    });

    it("restores an archived identity with its reserved ID only on trusted reimport", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.appendMessage(id, message);
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      await restart();
      await expect(conversationStore.importConversation(importParams())).rejects.toThrow("suppressed");
      expect(conversationStore.upsertCatalog("codex-desktop", catalog()).sessions).toEqual([]);

      const restored = await conversationStore.importConversation({ ...importParams(), restoreArchived: true });
      expect(restored).toMatchObject({ id, archived: false, engineTitle: "Fresh imported title", catalogSourceId: sourceId });
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(false);
      expect(await conversationStore.listMessages(id)).toEqual([{
        ...message, parts: message.parts.map((part) => ({ ...part, sessionId: id })),
      }]);
      expect(await conversationStore.getSteps(id, message.id)).toEqual(steps.map((step) => ({ ...step, sessionId: id })));
      await restart();
      expect(persistedRemovals()).toBeUndefined();
      expect(conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id).toBe(id);
    });

    it("upgrades an archived removal to local without later downgrading it", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await Promise.all([
        conversationStore.removeEngineConversation(id, "archived", sourceId),
        conversationStore.removeEngineConversation(id, "local", sourceId),
      ]);
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      expect(persistedRemovals()[0].kind).toBe("local");
      await expect(conversationStore.importConversation({ ...importParams(), restoreArchived: true })).rejects.toThrow("suppressed");
    });

    it("preserves archive suppression when reimport cannot write its files", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      const originalRename = fsp.rename;
      const rename = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === filePath(id, ".steps.json")) throw new Error("Steps write unavailable");
        return originalRename(from, to);
      });
      try {
        await expect(conversationStore.importConversation({ ...importParams(), restoreArchived: true })).rejects.toThrow("Steps write unavailable");
        expect(conversationStore.get(id)).toBeNull();
        expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(true);
        expect(fs.existsSync(filePath(id))).toBe(false);
        expect(fs.existsSync(filePath(id, ".steps.json"))).toBe(false);
      } finally {
        rename.mockRestore();
      }
      await restart();
      expect(persistedRemovals()[0]).toMatchObject({ conversationId: id, kind: "archived" });
    });

    it("allows only the first of two concurrent trusted imports to restore a reserved identity", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      const results = await Promise.allSettled([
        conversationStore.importConversation({ ...importParams(), title: "First restored title", restoreArchived: true }),
        conversationStore.importConversation({ ...importParams(), title: "Late restored title", restoreArchived: true }),
      ]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { id } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("Engine session is suppressed") });
      expect(conversationStore.get(id)?.engineTitle).toBe("First restored title");
      expect(conversationStore.list()).toHaveLength(1);
    });

    it("replaces residual files with empty content during trusted reimport", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      fs.writeFileSync(filePath(id), JSON.stringify([message]));
      fs.writeFileSync(filePath(id, ".steps.json"), JSON.stringify({ version: 1, conversationId: id, messages: { [message.id]: steps } }));

      const restored = await conversationStore.importConversation({ ...importParams(), messages: [], steps: {}, restoreArchived: true });
      expect(restored).toMatchObject({ id, messageCount: 0 });
      expect(await conversationStore.listMessages(id)).toEqual([]);
      expect((await conversationStore.getAllSteps(id))?.messages).toEqual({});
    });

    it("purges an in-flight write and rejects late writes to a removed mirror", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      const originalRename = fsp.rename;
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const rename = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === filePath(id)) {
          started();
          await gate;
        }
        return originalRename(from, to);
      });
      try {
        const write = conversationStore.appendMessage(id, message);
        await entered;
        const removed = conversationStore.removeEngineConversation(id, "archived", sourceId);
        const lateWrites = [
          conversationStore.ensureMessage(id, message),
          conversationStore.appendMessage(id, message),
          conversationStore.updateMessage(id, message.id, { error: "late" }),
          conversationStore.saveSteps(id, message.id, steps),
        ];
        release();
        await Promise.all([write, removed, ...lateWrites]);
        await expect(conversationStore.replaceMessageSnapshot(id, [])).rejects.toThrow("not found");
        expect(conversationStore.get(id)).toBeNull();
        expect(fs.existsSync(filePath(id))).toBe(false);
        expect(fs.existsSync(filePath(id, ".steps.json"))).toBe(false);
      } finally {
        release();
        rename.mockRestore();
      }
    });

    it("keeps suppression and retained files when its index cannot be persisted", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.appendMessage(id, message);
      await conversationStore.flushAll();
      const originalRename = fsp.rename;
      const rename = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === filePath("index")) throw new Error("Index write unavailable");
        return originalRename(from, to);
      });
      try {
        await expect(conversationStore.removeEngineConversation(id, "archived", sourceId)).rejects.toThrow("Index write unavailable");
        expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(true);
        expect(conversationStore.get(id)).toBeNull();
        expect(fs.existsSync(filePath(id))).toBe(true);
      } finally {
        rename.mockRestore();
      }
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      expect(fs.existsSync(filePath(id))).toBe(false);
    });

    it("does not resurrect a conversation removed during trusted archive reimport", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.removeEngineConversation(id, "archived", sourceId);
      const originalRename = fsp.rename;
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const rename = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === filePath(id)) {
          started();
          await gate;
        }
        return originalRename(from, to);
      });
      try {
        const restoring = conversationStore.importConversation({ ...importParams(), restoreArchived: true });
        await entered;
        const removed = conversationStore.removeEngineConversation(id, "local", sourceId);
        release();
        await expect(restoring).rejects.toThrow("removed while importing");
        await removed;
        expect(conversationStore.list()).toEqual([]);
        expect(persistedRemovals()[0]).toMatchObject({ conversationId: id, kind: "local" });
        expect(fs.existsSync(filePath(id))).toBe(false);
        expect(fs.existsSync(filePath(id, ".steps.json"))).toBe(false);
      } finally {
        release();
        rename.mockRestore();
      }
    });

    it("preserves ordinary delete semantics and removes local drafts without native identities", async () => {
      const id = conversationStore.upsertCatalog("codex-desktop", catalog()).sessions[0].id;
      await conversationStore.delete(id);
      expect(conversationStore.isSessionSuppressed("codex-desktop", nativeId, sourceId)).toBe(false);
      expect((await conversationStore.importConversation(importParams())).id).not.toBe(id);

      const draft = conversationStore.create({ engineType: "codex-desktop", directory: "/test" });
      await conversationStore.removeEngineConversation(draft.id, "local");
      await conversationStore.appendMessage(draft.id, message);
      await conversationStore.saveSteps(draft.id, message.id, steps);
      expect(conversationStore.get(draft.id)).toBeNull();
      expect(fs.existsSync(filePath(draft.id))).toBe(false);
      expect(fs.existsSync(filePath(draft.id, ".steps.json"))).toBe(false);
    });
  });

  describe("Catalog metadata", () => {
    function nativeSession(id = "native-session", patch: Partial<UnifiedSession> = {}): UnifiedSession {
      return {
        id, engineType: "codex-desktop", directory: "/session/cwd", title: "Native title",
        projectId: "native-project", time: { created: 10, updated: 20 },
        engineMeta: { codexThreadId: id, details: { value: "original" } }, ...patch,
      };
    }

    function snapshot(patch: Partial<EngineCatalogSnapshot> = {}): EngineCatalogSnapshot {
      return {
        sourceId: "local-source", revision: "revision-1", complete: true,
        projects: [{ id: "native-project", directory: "/primary/root", roots: ["/primary/root", "/secondary/root"], name: "Native project", order: 4, engineMeta: { details: { value: "original" } } }],
        sessions: [nativeSession()], ...patch,
      };
    }

    async function restart(): Promise<void> {
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      (conversationStore as any).catalogs = new Map();
      conversationStore.init();
    }

    async function addHistory(id: string): Promise<{ message: string; steps: string }> {
      await conversationStore.appendMessage(id, {
        id: "saved-message", role: "user", time: { created: 1 },
        parts: [{ id: "saved-text", messageId: "saved-message", sessionId: id, type: "text", text: "Keep this conversation" }],
      });
      await conversationStore.saveSteps(id, "saved-message", [{ id: "saved-step", messageId: "saved-message", sessionId: id, type: "reasoning", text: "Keep these steps" }]);
      return {
        message: fs.readFileSync(path.join(tmpDir, "conversations", `${id}.json`), "utf8"),
        steps: fs.readFileSync(path.join(tmpDir, "conversations", `${id}.steps.json`), "utf8"),
      };
    }

    function historyBytes(id: string) {
      return {
        message: fs.readFileSync(path.join(tmpDir, "conversations", `${id}.json`), "utf8"),
        steps: fs.readFileSync(path.join(tmpDir, "conversations", `${id}.steps.json`), "utf8"),
      };
    }

    it("adopts a matching manual record once while preserving its ID, history and local metadata", async () => {
      const manual = conversationStore.create({ engineType: "codex-desktop", directory: "/old/cwd", projectId: "dir-/old/cwd" });
      const createdAt = manual.createdAt;
      conversationStore.setEngineSession(manual.id, "native-session", { localOnly: "keep" });
      conversationStore.setCustomTitle(manual.id, "Local alias");
      const history = await addHistory(manual.id);
      const incoming = snapshot({ sessions: [nativeSession("native-session", { projectId: undefined })] });
      const first = conversationStore.upsertCatalog("codex-desktop", incoming);
      const repeated = conversationStore.upsertCatalog("codex-desktop", incoming);
      expect(first.sessions[0].id).toBe(manual.id);
      expect(repeated.sessions[0].id).toBe(manual.id);
      expect(conversationStore.list()).toHaveLength(1);
      expect(conversationStore.get(manual.id)).toMatchObject({
        createdAt, updatedAt: 20, customTitle: "Local alias", engineTitle: "Native title", messageCount: 1,
        projectId: null, directory: "/session/cwd", catalogSourceId: "local-source", catalogAvailable: true,
        engineSessionId: "native-session", engineMeta: { localOnly: "keep", codexThreadId: "native-session" },
      });
      expect(first.sessions[0].title).toBe("Native title");
      expect(historyBytes(manual.id)).toEqual(history);
      await restart();
      expect(conversationStore.upsertCatalog("codex-desktop", incoming).sessions[0].id).toBe(manual.id);
      expect(historyBytes(manual.id)).toEqual(history);
    });

    it.each(["sourceId", "codexHome"] as const)("keeps an unscoped native UUID with a different %s out of the current catalog", async field => {
      const manual = conversationStore.create({ engineType: "codex", directory: "/other/project" });
      const metadata = { [field]: field === "sourceId" ? "other-source" : path.join(tmpDir, "other-codex-home"), localOnly: "keep" };
      conversationStore.setEngineSession(manual.id, "01a13ef6-bc2d-7030-8e3b-76c50f20d412", metadata);
      const history = await addHistory(manual.id);
      const saved = structuredClone(manual);
      const incoming = snapshot({ sessions: [nativeSession(manual.engineSessionId!, { engineType: "codex" })] });
      const catalog = conversationStore.upsertCatalog("codex", incoming);

      expect(catalog.sessions[0].id).not.toBe(manual.id);
      expect(conversationStore.get(manual.id)).toEqual(saved);
      expect(historyBytes(manual.id)).toEqual(history);
      expect(conversationStore.list()).toHaveLength(2);
      await restart();
      expect(conversationStore.upsertCatalog("codex", incoming).sessions[0].id).toBe(catalog.sessions[0].id);
      expect(conversationStore.get(manual.id)?.engineMeta).toEqual(metadata);
      expect(historyBytes(manual.id)).toEqual(history);
    });

    it("keeps identical native IDs separate across sources and engines after restart", async () => {
      const a = conversationStore.upsertCatalog("codex-desktop", snapshot({ sourceId: "host:a" }));
      const b = conversationStore.upsertCatalog("codex-desktop", snapshot({ sourceId: "host%3Aa" }));
      const c = conversationStore.upsertCatalog("copilot", snapshot({ sourceId: "host:a", sessions: [nativeSession("native-session", { engineType: "copilot" })] }));
      expect(new Set([a.sessions[0].id, b.sessions[0].id, c.sessions[0].id]).size).toBe(3);
      expect(new Set([a.projects[0].id, b.projects[0].id, c.projects[0].id]).size).toBe(3);
      expect(conversationStore.findByEngineSession("native-session", "codex-desktop", "host:a")?.id).toBe(a.sessions[0].id);
      expect(conversationStore.findByEngineSession("native-session", "codex-desktop", "host%3Aa")?.id).toBe(b.sessions[0].id);
      expect(conversationStore.findByEngineSession("native-session", "copilot", "host:a")?.id).toBe(c.sessions[0].id);
      await restart();
      expect(conversationStore.upsertCatalog("codex-desktop", snapshot({ sourceId: "host:a" })).sessions[0].id).toBe(a.sessions[0].id);
      expect(conversationStore.upsertCatalog("codex-desktop", snapshot({ sourceId: "host%3Aa" })).sessions[0].id).toBe(b.sessions[0].id);
      conversationStore.markCatalogUnavailable("codex-desktop", "host:a");
      expect(conversationStore.get(a.sessions[0].id)?.catalogAvailable).toBe(false);
      expect(conversationStore.get(b.sessions[0].id)?.catalogAvailable).toBe(true);
      expect(conversationStore.get(c.sessions[0].id)?.catalogAvailable).toBe(true);
    });

    it("leaves unrelated legacy records in the same engine untouched", async () => {
      const legacy = conversationStore.create({ engineType: "codex-desktop", directory: "/legacy/cwd" });
      conversationStore.setEngineSession(legacy.id, "legacy-native", { legacy: true });
      conversationStore.setCustomTitle(legacy.id, "Legacy alias");
      const history = await addHistory(legacy.id);
      const metadata = structuredClone(conversationStore.get(legacy.id));
      conversationStore.upsertCatalog("codex-desktop", snapshot());
      conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [], sessions: [] }));
      conversationStore.markCatalogUnavailable("codex-desktop", "local-source");
      expect(conversationStore.get(legacy.id)).toEqual(metadata);
      expect(historyBytes(legacy.id)).toEqual(history);
      expect(conversationStore.deriveProjects()).toEqual([{ id: "dir-/legacy/cwd", directory: "/legacy/cwd", name: "cwd" }]);
    });

    it("persists empty and multi-root canonical projects without deriving them from session cwd", async () => {
      conversationStore.create({ engineType: "opencode", directory: "Z:\\legacy\\repo" });
      const input = snapshot({ projects: [
        { id: "empty", name: "Empty project", directory: "", roots: [], order: 0 },
        { id: "native-project", name: "Multiple roots", directory: "/primary/root", roots: ["/primary/root", "/secondary/root"], order: 7 },
      ] });
      const mapped = conversationStore.upsertCatalog("codex-desktop", input);
      expect(conversationStore.deriveProjects()).toEqual([{ id: "dir-Z:/legacy/repo", directory: "Z:/legacy/repo", name: "repo" }]);
      await restart();
      const restored = conversationStore.listCatalogs()[0];
      expect(restored.projects.map((project) => [project.catalogProjectId, project.name, project.roots, project.order])).toEqual([
        ["empty", "Empty project", [], 0], ["native-project", "Multiple roots", ["/primary/root", "/secondary/root"], 7],
      ]);
      expect(restored.sessions[0].id).toBe(mapped.sessions[0].id);
      expect(restored.sessions[0].directory).toBe("/session/cwd");
      expect(restored.sessions[0].projectId).toBe(makeCatalogProjectId("codex-desktop", "local-source", "native-project"));
      expect(conversationStore.getCatalogProject(mapped.projects[0].id)?.roots).toEqual([]);
      const index = JSON.parse(fs.readFileSync(path.join(tmpDir, "conversations", "index.json"), "utf8"));
      expect(index.version).toBe(1);
      expect(index.catalogs).toHaveLength(1);
    });

    it("moves explicit membership without changing cwd and retains membership in a partial metadata page", () => {
      const initial = conversationStore.upsertCatalog("codex-desktop", snapshot());
      const moved = conversationStore.upsertCatalog("codex-desktop", snapshot({ revision: "moved", projects: [
        { id: "other-project", directory: "/unrelated/root", roots: ["/unrelated/root"], name: "Destination" },
      ], sessions: [nativeSession("native-session", { projectId: "other-project" })] }));
      expect(moved.sessions[0]).toMatchObject({ id: initial.sessions[0].id, directory: "/session/cwd", projectId: makeCatalogProjectId("codex-desktop", "local-source", "other-project") });
      const partial = conversationStore.upsertCatalog("codex-desktop", snapshot({ complete: false, projects: [], sessions: [nativeSession("native-session", { projectId: undefined })] }));
      expect(partial.sessions[0].projectId).toBe(moved.sessions[0].projectId);
      const unassigned = conversationStore.upsertCatalog("codex-desktop", snapshot({ complete: false, projects: [], sessions: [nativeSession("native-session", { projectId: null })] }));
      expect(unassigned.sessions[0]).toMatchObject({ id: initial.sessions[0].id, directory: "/session/cwd", projectId: null });
    });

    it("preserves missing rows and project order on partial pages, then marks complete omissions unavailable", async () => {
      const initial = conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [
        { id: "p1", directory: "/root1", name: "First", order: 5 },
        { id: "p2", directory: "/root2", name: "Second", order: 8 },
      ], sessions: [nativeSession("s1", { projectId: "p1" }), nativeSession("s2", { projectId: "p2" })] }));
      const retainedId = initial.sessions.find((session) => session.engineMeta?.codexThreadId === "s2")!.id;
      const history = await addHistory(retainedId);
      const partial = conversationStore.upsertCatalog("codex-desktop", snapshot({ complete: false, projects: [
        { id: "p2", directory: "/root2", name: "Renamed second" }, { id: "p3", directory: "/root3", name: "Third" },
      ], sessions: [nativeSession("s1", { projectId: "p1" })] }));
      expect(partial.sessions.find((session) => session.id === retainedId)?.catalogAvailable).toBe(true);
      expect(partial.projects.map((project) => [project.catalogProjectId, project.order, project.catalogAvailable])).toEqual([["p1", 5, true], ["p2", 8, true], ["p3", 9, true]]);
      const complete = conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [{ id: "p3", directory: "/root3" }], sessions: [nativeSession("s1", { projectId: "p3" })] }));
      expect(complete.sessions.find((session) => session.id === retainedId)?.catalogAvailable).toBe(false);
      expect(conversationStore.getCatalogProject(makeCatalogProjectId("codex-desktop", "local-source", "p2"))).toMatchObject({ name: "Renamed second", catalogAvailable: false });
      expect(historyBytes(retainedId)).toEqual(history);
      expect(conversationStore.list()).toHaveLength(2);
      const restored = conversationStore.upsertCatalog("codex-desktop", snapshot({ complete: false, projects: [], sessions: [nativeSession("s2", { projectId: "p2" })] }));
      expect(restored.sessions.find((session) => session.id === retainedId)?.catalogAvailable).toBe(true);
    });

    it("keeps pending creation unknown until native catalog confirmation", () => {
      conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [], sessions: [] }));
      const pending = conversationStore.create({ engineType: "codex-desktop", directory: "/session/cwd", projectId: null, catalogSourceId: "local-source" });
      conversationStore.setEngineSession(pending.id, "pending-native");
      conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [], sessions: [] }));
      expect(conversationStore.get(pending.id)?.catalogAvailable).toBeUndefined();
      conversationStore.markCatalogUnavailable("codex-desktop", "local-source");
      expect(conversationStore.get(pending.id)?.catalogAvailable).toBeUndefined();
      const confirmed = conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [], sessions: [nativeSession("pending-native", { projectId: null })] }));
      expect(confirmed.sessions[0]).toMatchObject({ id: pending.id, catalogAvailable: true });
      conversationStore.upsertCatalog("codex-desktop", snapshot({ projects: [], sessions: [] }));
      expect(conversationStore.get(pending.id)?.catalogAvailable).toBe(false);
    });

    it("does not clear stored runtime selections when catalog fields are undefined", () => {
      const initial = conversationStore.upsertCatalog("codex-desktop", snapshot({ sessions: [nativeSession("native-session", { mode: "plan", modelId: "selected-model", reasoningEffort: "high", serviceTier: "fast" })] }));
      conversationStore.upsertCatalog("codex-desktop", snapshot({ sessions: [nativeSession("native-session", { mode: undefined, modelId: undefined, reasoningEffort: undefined, serviceTier: undefined })] }));
      expect(conversationStore.get(initial.sessions[0].id)).toMatchObject({ mode: "plan", modelId: "selected-model", reasoningEffort: "high", serviceTier: "fast" });
    });

    it("retains empty source registries and offline history after restart", async () => {
      const manual = conversationStore.create({ engineType: "claude", directory: "/manual" });
      const active = conversationStore.upsertCatalog("codex-desktop", snapshot());
      const history = await addHistory(active.sessions[0].id);
      conversationStore.upsertCatalog("codex-desktop", snapshot({ sourceId: "empty-source", projects: [], sessions: [] }));
      conversationStore.markCatalogUnavailable("codex-desktop", "local-source");
      conversationStore.markCatalogUnavailable("codex-desktop", "empty-source");
      await restart();
      expect(conversationStore.listCatalogs()).toHaveLength(2);
      expect(conversationStore.listCatalogs().find((catalog) => catalog.sourceId === "empty-source")).toMatchObject({ engineType: "codex-desktop", complete: false, projects: [], sessions: [] });
      expect(conversationStore.get(active.sessions[0].id)?.catalogAvailable).toBe(false);
      expect(conversationStore.get(manual.id)?.catalogAvailable).toBeUndefined();
      expect(historyBytes(active.sessions[0].id)).toEqual(history);
    });

    it("detaches incoming and returned catalog metadata from persistent state", () => {
      const incoming = snapshot();
      const result = conversationStore.upsertCatalog("codex-desktop", incoming);
      incoming.projects[0].roots!.push("/changed-input");
      (incoming.sessions[0].engineMeta!.details as { value: string }).value = "changed-input";
      result.projects[0].roots!.push("/changed-output");
      (result.sessions[0].engineMeta!.details as { value: string }).value = "changed-output";
      const project = conversationStore.getCatalogProject(result.projects[0].id)!;
      (project.engineMeta!.details as { value: string }).value = "changed-getter";
      const current = conversationStore.listCatalogs()[0];
      expect(current.projects[0].roots).toEqual(["/primary/root", "/secondary/root"]);
      expect(current.projects[0].engineMeta).toMatchObject({ details: { value: "original" } });
      expect(current.sessions[0].engineMeta).toMatchObject({ details: { value: "original" } });
    });

    it("rejects invalid snapshots before changing existing metadata", () => {
      conversationStore.upsertCatalog("codex-desktop", snapshot());
      const before = JSON.stringify(conversationStore.listCatalogs());
      expect(() => conversationStore.upsertCatalog("codex-desktop", snapshot({ sessions: [nativeSession("native-session", { title: "Not applied" }), nativeSession("invalid", { time: { created: NaN, updated: 1 } })] }))).toThrow("Invalid catalog session metadata");
      expect(() => conversationStore.upsertCatalog("codex-desktop", snapshot({ engineType: "copilot" }))).toThrow("Catalog engine identity");
      expect(() => conversationStore.upsertCatalog("codex-desktop", snapshot({ sessions: [nativeSession("same"), nativeSession("same")] }))).toThrow("unique and non-empty");
      expect(JSON.stringify(conversationStore.listCatalogs())).toBe(before);
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
      const conv = conversationStore.create({ engineType: "opencode", directory: "/persist" });
      conversationStore.update(conv.id, { customTitle: "Keep Me" });
      await conversationStore.flushAll();
      (conversationStore as any).initialized = false;
      (conversationStore as any).index = new Map();
      conversationStore.init();
      const recovered = conversationStore.get(conv.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.customTitle).toBe("Keep Me");

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
