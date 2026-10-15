import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineManager } from "../../../../electron/main/gateway/engine-manager";
import { MockEngineAdapter } from "../../../../electron/main/engines/mock-adapter";
import { conversationStore } from "../../../../electron/main/services/conversation-store";
import type { UnifiedMessage } from "../../../../src/types/unified";

const paths = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../../../electron/main/services/app-paths", () => ({
  getConversationsPath: () => join(paths.directory, "conversations"),
}));
vi.mock("../../../../electron/main/services/logger", () => ({
  engineManagerLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  conversationStoreLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getDefaultEngineFromSettings: () => "codex",
}));
vi.mock("../../../../electron/main/services/default-workspace", () => ({ getDefaultWorkspacePath: () => paths.directory }));
vi.mock("../../../../electron/main/services/worktree-manager", () => ({ worktreeManager: {} }));

describe("authoritative history persistence", () => {
  let manager: EngineManager;
  let adapter: MockEngineAdapter;
  let conversationId: string;
  const nativeId = "native-history";
  const message = (index: number, text = `Message ${index}`): UnifiedMessage => ({
    id: `native-message-${index}`, sessionId: nativeId, role: "assistant",
    time: { created: index + 1, completed: index + 2 },
    parts: [
      { id: `text-${index}`, type: "text", messageId: `native-message-${index}`, sessionId: nativeId, text },
      { id: `reasoning-${index}`, type: "reasoning", messageId: `native-message-${index}`, sessionId: nativeId, text: "Checked the result" },
    ],
  });
  const publish = (messages: UnifiedMessage[]) => {
    for (const value of messages) adapter.emit("message.updated", { sessionId: nativeId, message: value });
  };

  beforeEach(() => {
    paths.directory = fs.mkdtempSync(join(tmpdir(), "codemux-history-persistence-"));
    Object.assign(conversationStore, { initialized: false, basePath: "", index: new Map(), indexDirty: false, writeLocks: new Map() });
    conversationStore.init();
    const conversation = conversationStore.create({ engineType: "codex", directory: paths.directory });
    conversationId = conversation.id;
    conversationStore.setEngineSession(conversationId, nativeId);
    manager = new EngineManager();
    adapter = new MockEngineAdapter({ engineType: "codex" });
    vi.spyOn(adapter, "getCapabilities").mockReturnValue({ authoritativeSessionState: true });
    vi.spyOn(adapter, "hasSession").mockReturnValue(true);
    manager.registerAdapter(adapter);
    manager.initFromStore();
  });

  afterEach(async () => {
    await manager.flushPendingState();
    await conversationStore.flushAll();
    vi.restoreAllMocks();
    fs.rmSync(paths.directory, { recursive: true, force: true });
  });

  it.each([false, true])("persists a 1935-message native snapshot with bounded projection writes (existing: %s)", async (existing) => {
    const history = Array.from({ length: 1935 }, (_, index) => message(index));
    if (existing) await conversationStore.replaceMessageSnapshot(conversationId, history);
    const write = vi.spyOn(fsp, "writeFile");

    publish(history);
    await manager.flushPendingState();

    const projectionWrites = write.mock.calls.filter(([file]) => String(file).includes(conversationId));
    expect(projectionWrites).toHaveLength(existing ? 0 : 2);
    expect((await conversationStore.listMessages(conversationId)).map(value => value.id)).toEqual(history.map(value => value.id));
    expect(Object.keys((await conversationStore.getAllSteps(conversationId))!.messages)).toHaveLength(history.length);
  }, 60_000);

  it("loads a cold owner snapshot once and reads lazy steps without persisting history again", async () => {
    const history = Array.from({ length: 64 }, (_, index) => message(index));
    const active = { ...message(65), time: { created: 66 } };
    history.push(active);
    vi.mocked(adapter.hasSession).mockReturnValue(false);
    vi.spyOn(adapter, "restoreSession").mockImplementation(async () => {
      publish(history);
      vi.mocked(adapter.hasSession).mockReturnValue(true);
      return { id: nativeId, engineType: "codex", directory: paths.directory, time: { created: 1, updated: 2 } };
    });
    const list = vi.spyOn(adapter, "listMessages").mockResolvedValue(history);
    const write = vi.spyOn(fsp, "writeFile");

    const loaded = await manager.listMessages(conversationId);

    expect(loaded).toHaveLength(history.length);
    expect(loaded[0].parts).toHaveLength(1);
    expect(loaded[0].stepCount).toBe(1);
    expect(loaded.at(-1)?.parts).toHaveLength(2);
    expect(write.mock.calls.filter(([file]) => String(file).includes(conversationId)).length).toBeLessThanOrEqual(4);
    write.mockClear();
    list.mockClear();
    const steps = await Promise.all([manager.getMessageSteps(conversationId, history[0].id), manager.getMessageSteps(conversationId, history[1].id)]);
    expect(steps.map(parts => parts.length)).toEqual([1, 1]);
    expect(list).toHaveBeenCalledOnce();
    expect(write.mock.calls.filter(([file]) => String(file).includes(conversationId))).toHaveLength(0);
  });

  it("keeps events arriving during an owner read after the returned snapshot", async () => {
    let release!: (value: UnifiedMessage[]) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(adapter, "listMessages").mockImplementation(() => {
      started();
      return new Promise((resolve) => { release = resolve; });
    });
    const loading = manager.listMessages(conversationId);
    await reading;
    adapter.emit("message.removed", { sessionId: nativeId, messageId: message(1).id });
    publish([message(2, "After the snapshot")]);
    release([message(1)]);
    await loading;
    await manager.flushPendingState();

    const saved = await conversationStore.listMessages(conversationId);
    expect(saved.map(value => value.id)).toEqual([message(2).id]);
    expect(saved[0].parts[0]).toMatchObject({ text: "After the snapshot" });
    expect(await conversationStore.getSteps(conversationId, message(1).id)).toEqual([]);
  });

  it("does not replace newer events with an older pending lazy step read", async () => {
    let release!: (value: UnifiedMessage[]) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const list = vi.spyOn(adapter, "listMessages").mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { release = resolve; });
    }).mockResolvedValue([message(1), message(2)]);
    const oldSteps = manager.getMessageSteps(conversationId, message(1).id);
    await reading;
    publish([message(2)]);
    await manager.flushPendingState();
    const loading = manager.listMessages(conversationId);
    release([message(1)]);
    await Promise.all([loading, oldSteps]);

    expect(list).toHaveBeenCalledTimes(2);
    expect((await conversationStore.listMessages(conversationId)).map(value => value.id)).toEqual([message(1).id, message(2).id]);
  });

  it("normalizes tool presentation when completed steps are loaded lazily", async () => {
    const value = message(1);
    value.parts = [{
      id: "tool", messageId: value.id, sessionId: nativeId, type: "tool", callId: "call",
      normalizedTool: "edit", originalTool: "edit", title: "Edit", kind: "edit",
      state: { status: "completed", input: { path: join(paths.directory, "index.ts") }, output: "Updated",
        metadata: { diff: "verified diff" }, time: { start: 1, end: 2, duration: 1 } },
    }];
    vi.spyOn(adapter, "listMessages").mockResolvedValue([value]);
    const steps = await manager.getMessageSteps(conversationId, value.id);
    expect(steps[0]).toMatchObject({ sessionId: conversationId, diff: "verified diff", displayActions: [{ kind: "edit", path: "index.ts" }] });
    expect(value.parts[0]).not.toHaveProperty("diff");
  });

  it("preserves update, removal, and later update order across a pending history batch", async () => {
    publish([message(1), message(2)]);
    adapter.emit("message.removed", { sessionId: nativeId, messageId: message(1).id });
    publish([message(1, "Restored"), { ...message(2, "Corrected"), parts: [] }]);
    await manager.flushPendingState();

    const saved = await conversationStore.listMessages(conversationId);
    expect(saved.map(value => value.id)).toEqual([message(2).id, message(1).id]);
    expect(saved.find(value => value.id === message(1).id)?.parts[0]).toMatchObject({ text: "Restored", sessionId: conversationId });
    expect(await conversationStore.getSteps(conversationId, message(2).id)).toEqual([]);
    expect(await conversationStore.getSteps(conversationId, message(1).id)).toHaveLength(1);
  });
});
