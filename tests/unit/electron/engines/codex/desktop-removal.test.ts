import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopAdapter, type CodexDesktopAdapterOptions } from "../../../../../electron/main/engines/codex/desktop-adapter";
import type { CodexDesktopIpcClient, DesktopThreadSnapshot } from "../../../../../electron/main/engines/codex/desktop-ipc-client";
import { convertDesktopConversation } from "../../../../../electron/main/engines/codex/desktop-state";

const ID = "native-thread";
const OWNER = "original-owner";

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ID, hostId: "local", cwd: "/repo", title: "Task", createdAt: 1000, updatedAt: 2000,
    resumeState: "resumed", latestModel: "fixture", turns: [], requests: [], ...overrides };
}

function turn(status = "completed") {
  return { turnId: "native-turn", status, turnStartedAtMs: 1000, durationMs: status === "completed" ? 1000 : null,
    items: [{ id: "native-user", type: "userMessage", content: [{ type: "text", text: "Original prompt" }] }] };
}

class Client extends EventEmitter {
  connected = true;
  clientId = "codemux-follower";
  owner: string | null = OWNER;
  state = state();
  revision = 0;
  connect = vi.fn(async () => { this.connected = true; });
  close = vi.fn(() => { this.connected = false; this.emit("close"); });
  discoverOwner = vi.fn(async () => this.owner ? { ownerClientId: this.owner, supportsUntrustedAppInput: true } : null);
  followThread = vi.fn(async (): Promise<DesktopThreadSnapshot> => ({ type: "snapshot", revision: this.revision, conversationState: this.state }));
  unfollowThread = vi.fn();
  loadCompleteHistory = vi.fn(async () => { this.publish(); return {}; });
  publish(): void {
    this.emit("stream", { conversationId: ID, hostId: "local", ownerClientId: OWNER,
      change: { type: "snapshot", revision: ++this.revision, conversationState: this.state } });
  }
}

const adapters = new Set<CodexDesktopAdapter>();
function fixture(options: Partial<CodexDesktopAdapterOptions> = {}) {
  const client = new Client();
  const archive = vi.fn(async (id: string, _archived: boolean, _meta: Record<string, unknown>) => ({ thread: { id, cwd: "/repo" }, archived: true }));
  const discard = vi.fn(async (_id: string) => {});
  const adapter = new CodexDesktopAdapter({ client: client as unknown as CodexDesktopIpcClient, setThreadArchived: archive, discardThread: discard, ...options });
  adapters.add(adapter);
  return { client, archive, discard, adapter };
}
afterEach(async () => { await Promise.all([...adapters].map((adapter) => adapter.stop())); adapters.clear(); });

describe("Codex Desktop explicit removal", () => {
  it("discards a complete empty thread locally without a native archive", async () => {
    const f = fixture();
    expect(await f.adapter.removeSession(ID)).toBe("local");
    expect(f.client.loadCompleteHistory).toHaveBeenCalledExactlyOnceWith(ID, OWNER);
    expect(f.discard).toHaveBeenCalledExactlyOnceWith(ID);
    expect(f.archive).not.toHaveBeenCalled();
    expect(await f.adapter.listSessions()).toEqual([]);
  });

  it("uses fresh complete owner history before deciding whether to archive", async () => {
    const f = fixture();
    await f.adapter.attachThread(ID);
    f.client.state = state({ turns: [turn()] });
    expect(await f.adapter.removeSession(ID)).toBe("archived");
    expect(f.archive).toHaveBeenCalledExactlyOnceWith(ID, true, { codexThreadId: ID });
    expect(f.discard).not.toHaveBeenCalled();
    expect(await f.adapter.getSession(ID)).toBeNull();
    expect(await f.adapter.listSessions()).toEqual([]);
  });

  it("uses fresh stored history instead of an unavailable empty live cache", async () => {
    const readStoredThread = vi.fn(async () => ({ thread: { id: ID, cwd: "/repo", turns: [{ id: "native-turn", status: "completed", items: turn().items }] }, archived: false }));
    const f = fixture({ readStoredThread });
    await f.adapter.attachThread(ID);
    f.client.owner = null;
    f.client.emit("ownerDisconnected", OWNER);
    expect(await f.adapter.removeSession(ID)).toBe("archived");
    expect(readStoredThread).toHaveBeenCalled();
    expect(f.archive).toHaveBeenCalledOnce();
    expect(f.discard).not.toHaveBeenCalled();
  });

  it.each(["refused", "wrong-id", "not-archived"])("preserves the local conversation when native removal is %s", async (failure) => {
    const f = fixture();
    f.client.state = state({ turns: [turn()] });
    if (failure === "refused") f.archive.mockRejectedValueOnce(new Error("Native writer refused archive"));
    if (failure === "wrong-id") f.archive.mockResolvedValueOnce({ thread: { id: "different-thread", cwd: "/repo" }, archived: true });
    if (failure === "not-archived") f.archive.mockResolvedValueOnce({ thread: { id: ID, cwd: "/repo" }, archived: false });
    await expect(f.adapter.removeSession(ID)).rejects.toThrow();
    expect(await f.adapter.listSessions()).toHaveLength(1);
    expect(f.adapter.hasSession(ID)).toBe(true);
    expect(f.client.unfollowThread).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });

  it.each([
    { name: "active", changes: { turns: [turn("inProgress")] }, error: "current turn" },
    { name: "pending", changes: { requests: [{ id: 7, method: "item/commandExecution/requestApproval", params: { command: "pwd" } }] }, error: "pending interactions" },
    { name: "incomplete", changes: { turnsPagination: { hasLoadedOldest: false } }, error: "complete conversation" },
  ])("rejects $name state before either removal callback", async ({ changes, error }) => {
    const f = fixture();
    f.client.state = state(changes);
    await expect(f.adapter.removeSession(ID)).rejects.toThrow(error);
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
    expect(f.client.unfollowThread).not.toHaveBeenCalled();
  });

  it("keeps ordinary lifecycle cleanup free of archive and discard callbacks", async () => {
    const f = fixture();
    f.client.state = state({ turns: [turn()] });
    await f.adapter.attachThread(ID);
    await f.adapter.deleteSession(ID);
    await f.adapter.stop();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });
});

describe("Codex Desktop archived exclusion", () => {
  it("excludes archived import candidates before returning their metadata", async () => {
    const candidate = { engineSessionId: ID, title: "Active task", directory: "/repo", createdAt: 1, updatedAt: 2, alreadyImported: false };
    const f = fixture({ listCandidates: async () => [{ ...candidate, engineSessionId: "archived-thread", title: "Archived task", archived: true }, candidate] });
    expect((await f.adapter.listHistoricalSessions(10)).map((session) => session.engineSessionId)).toEqual([ID]);
    expect(f.client.discoverOwner).not.toHaveBeenCalled();
  });

  it.each(["stored-flag", "native-error"])("never publishes archived metadata or history after %s", async (mode) => {
    const readStoredThread = vi.fn(async () => ({ thread: { id: ID, cwd: "/private", name: "Archived title", turns: [{ id: "hidden-turn", items: turn().items }] }, archived: true }));
    if (mode === "native-error") readStoredThread.mockRejectedValue(Object.assign(new Error("Archived native thread"), { code: "CODEX_THREAD_ARCHIVED" }));
    const f = fixture({ readStoredThread });
    f.client.owner = null;
    const sessionUpdated = vi.fn();
    const messageUpdated = vi.fn();
    const removed = vi.fn();
    f.adapter.on("session.updated", sessionUpdated);
    f.adapter.on("message.updated", messageUpdated);
    f.adapter.on("session.removed", removed);
    expect(await f.adapter.getSession(ID)).toBeNull();
    expect(await f.adapter.listSessions()).toEqual([]);
    await expect(f.adapter.listMessages(ID)).rejects.toThrow("not synchronized");
    expect(await f.adapter.removeSession(ID)).toBe("archived");
    expect(sessionUpdated).not.toHaveBeenCalled();
    expect(messageUpdated).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: ID });
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("drops an excluded catalog record and rejects late owner streams", async () => {
    const readStoredThread = vi.fn(async () => { throw Object.assign(new Error("Archived native thread"), { code: "CODEX_THREAD_ARCHIVED" }); });
    const f = fixture({ readStoredThread });
    f.client.state = state({ turns: [turn()] });
    const session = await f.adapter.attachThread(ID);
    const snapshot = { sourceId: "native-home", revision: "1", complete: true, projects: [], sessions: [session] };
    f.adapter.publishCatalog(snapshot);
    const removed = vi.fn();
    const messageUpdated = vi.fn();
    f.adapter.on("session.removed", removed);
    f.adapter.on("message.updated", messageUpdated);
    f.adapter.publishCatalog({ ...snapshot, revision: "2", sessions: [] });
    await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce());
    f.client.publish();
    expect(await f.adapter.listSessions()).toEqual([]);
    expect(await f.adapter.getSession(ID)).toBeNull();
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: ID });
    expect(messageUpdated).not.toHaveBeenCalled();
    f.adapter.publishCatalog({ ...snapshot, revision: "3" });
    expect((await f.adapter.attachThread(ID)).id).toBe(ID);
  });

  it("preserves an omitted catalog mirror when native storage is temporarily unavailable", async () => {
    const readStoredThread = vi.fn(async () => { throw new Error("Native storage temporarily unavailable"); });
    const f = fixture({ readStoredThread });
    const session = await f.adapter.attachThread(ID);
    const snapshot = { sourceId: "native-home", revision: "1", complete: true, projects: [], sessions: [session] };
    f.adapter.publishCatalog(snapshot);
    const removed = vi.fn();
    f.adapter.on("session.removed", removed);
    f.adapter.publishCatalog({ ...snapshot, revision: "2", sessions: [] });
    await vi.waitFor(() => expect(readStoredThread).toHaveBeenCalledOnce());
    expect(removed).not.toHaveBeenCalled();
    expect(f.adapter.hasSession(ID)).toBe(true);
    expect(await f.adapter.listSessions()).toHaveLength(1);
  });

  it("filters archived rows before publishing a catalog to clients", () => {
    const f = fixture();
    const session = { ...convertDesktopConversation(state()).session, archived: true };
    const updated = vi.fn();
    f.adapter.on("catalog.updated", updated);
    f.adapter.publishCatalog({ sourceId: "native-home", revision: "1", complete: true, projects: [], sessions: [session] });
    expect(updated).toHaveBeenCalledExactlyOnceWith({ sourceId: "native-home", revision: "1", complete: true, projects: [], sessions: [] });
  });

  it("requires confirmed removal and disables direct archive and restore controls", async () => {
    const f = fixture();
    expect(f.adapter.getCapabilities()).toMatchObject({ confirmedSessionRemoval: true, hideArchivedSessions: true, sessionArchive: false });
    await expect(f.adapter.setSessionArchived(ID, true)).rejects.toThrow("do not expose");
    await expect(f.adapter.setSessionArchived(ID, false)).rejects.toThrow("do not expose");
    expect(f.archive).not.toHaveBeenCalled();
  });
});
