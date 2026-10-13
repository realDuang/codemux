import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../../../../electron/main/engines/codex";
import type { DesktopCatalogMethod } from "../../../../../electron/main/engines/codex/desktop-catalog";

vi.mock("../../../../../electron/main/services/logger", () => ({
  codexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const adapter = new CodexAdapter();
  const start = vi.spyOn(adapter, "start").mockResolvedValue();
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => ({ data: [], nextCursor: null }));
  (adapter as unknown as { client: unknown }).client = { running: true, request };
  return { adapter, start, request, client: adapter.createDesktopCatalogClient() };
}

describe("CodexAdapter.createDesktopCatalogClient", () => {
  it("permits canonical metadata but never thread execution or scan-and-repair", async () => {
    const { client, start, request } = fixture();
    await expect(client.request("thread/resume" as DesktopCatalogMethod, { threadId: "thread" })).rejects.toThrow("Unsupported");
    await expect(client.request("thread/read", { threadId: "thread", includeTurns: true })).rejects.toThrow("turn bodies");
    await expect(client.request("thread/list", { modelProviders: [] })).rejects.toThrow("scan-and-repair");
    expect(start).not.toHaveBeenCalled();
    await client.request("project/list", { cursor: null, limit: 100 });
    expect(start).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledExactlyOnceWith("project/list", { cursor: null, limit: 100 });
    client.dispose?.();
  });

  it("revokes a late request after startup without restarting or sending it", async () => {
    const { client, start, request } = fixture();
    let finishStart!: () => void;
    start.mockImplementation(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const pending = client.request("project/list", {});
    client.dispose?.();
    finishStart();
    await expect(pending).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
    await expect(client.request("project/list", {})).rejects.toThrow("stopped");
    expect(start).toHaveBeenCalledOnce();
  });

  it("removes only its notification listeners on disposal", () => {
    const { client, adapter } = fixture();
    const listener = vi.fn();
    client.subscribe?.(listener);
    const notify = (adapter as unknown as { handleNotification(method: string, params: unknown): void }).handleNotification.bind(adapter);
    notify("project/changed", { projectId: "project", changeType: "updated" });
    expect(listener).toHaveBeenCalledExactlyOnceWith("project/changed", { projectId: "project", changeType: "updated" });
    notify("item/agentMessage/delta", { threadId: "thread", delta: "private transcript fixture" });
    expect(listener).toHaveBeenCalledOnce();
    client.dispose?.();
    notify("project/changed", { projectId: "project", changeType: "deleted" });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("Codex catalog project creation", () => {
  it("passes projectId only on a new start and reports the returned native assignment", async () => {
    const { adapter, request } = fixture();
    vi.spyOn(adapter as unknown as { refreshCommandsForDirectory(directory: string): Promise<unknown[]> }, "refreshCommandsForDirectory").mockResolvedValue([]);
    request.mockImplementation(async (method) => method === "thread/start"
      ? { thread: { id: "new-thread", projectId: "returned-project" }, model: "model" } : { data: [] });
    const session = await adapter.createSession("/fixture", { catalogSourceId: "source", catalogProjectId: "requested-project" });
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toHaveProperty("projectId", "requested-project");
    expect(session).toMatchObject({ projectId: "returned-project", engineMeta: { catalogSourceId: "source", catalogProjectId: "returned-project" } });
  });

  it("never applies a requested project override during strict restore", async () => {
    const { adapter, request } = fixture();
    vi.spyOn(adapter as unknown as { refreshCommandsForDirectory(directory: string): Promise<unknown[]> }, "refreshCommandsForDirectory").mockResolvedValue([]);
    request.mockImplementation(async (method) => method === "thread/resume"
      ? { thread: { id: "stored-thread", projectId: "original-project", canAcceptDirectInput: true }, model: "model" } : { data: [] });
    const session = await adapter.createSession("/fixture", { codexThreadId: "stored-thread", codexDesktopOwner: "codemux", catalogSourceId: "source", catalogProjectId: "different-project" });
    expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toEqual({ threadId: "stored-thread", persistExtendedHistory: true });
    expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(session).toMatchObject({ projectId: "original-project", engineMeta: { catalogProjectId: "original-project" } });
  });

  it("leaves ordinary Codex creation without catalog metadata unchanged", async () => {
    const { adapter, request } = fixture();
    vi.spyOn(adapter as unknown as { refreshCommandsForDirectory(directory: string): Promise<unknown[]> }, "refreshCommandsForDirectory").mockResolvedValue([]);
    request.mockImplementation(async (method) => method === "thread/start" ? { thread: { id: "ordinary", projectId: null } } : { data: [] });
    const session = await adapter.createSession("/fixture");
    expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).not.toHaveProperty("projectId");
    expect(session).not.toHaveProperty("projectId");
    expect(session.engineMeta).toEqual({ codexThreadId: "ordinary" });
  });
});
