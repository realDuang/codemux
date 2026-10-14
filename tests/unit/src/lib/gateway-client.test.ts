import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(),
  isElectron: vi.fn<() => boolean>(),
  getWsUrl: vi.fn<() => Promise<string>>(),
}));

vi.mock("../../../../src/lib/auth", () => ({ Auth: { getToken: mocks.getToken } }));
vi.mock("../../../../src/lib/platform", () => ({ isElectron: mocks.isElectron }));
vi.mock("../../../../src/lib/electron-api", () => ({ gatewayAPI: { getWsUrl: mocks.getWsUrl } }));

import { GatewayClient } from "../../../../src/lib/gateway-client";
import type { EngineCatalogSnapshot, UnifiedProject } from "../../../../src/types/unified";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeFromServer(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "Connection interrupted" });
  }

  authenticate(): void {
    const auth = JSON.parse(this.send.mock.calls[0][0]);
    this.onmessage?.({ data: JSON.stringify({ type: "response", requestId: auth.requestId, payload: { authenticated: true } }) });
  }
}

describe("GatewayClient authentication", () => {
  let client: GatewayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.getToken.mockReturnValue("device-token");
    mocks.isElectron.mockReturnValue(false);
    mocks.getWsUrl.mockResolvedValue("ws://127.0.0.1:8233/ws");
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", { location: { protocol: "https:", host: "codemux.example.test" } });
    client = new GatewayClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connect(url?: string): Promise<FakeWebSocket> {
    const pending = client.connect(url);
    await Promise.resolve();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.authenticate();
    await pending;
    return ws;
  }

  it("uses the existing remote origin and device JWT for browser connections", async () => {
    const ws = await connect();
    const url = new URL(ws.url);

    expect(url.origin).toBe("wss://codemux.example.test");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.has("token")).toBe(false);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ type: "auth", token: "device-token" });
    expect(client.connected).toBe(true);
    expect(mocks.getWsUrl).not.toHaveBeenCalled();
  });

  it("preserves the native IPC endpoint and adds its existing device JWT", async () => {
    mocks.isElectron.mockReturnValue(true);
    mocks.getWsUrl.mockResolvedValueOnce("ws://127.0.0.1:8233/ws?native=1");

    const ws = await connect();
    const url = new URL(ws.url);

    expect(mocks.getWsUrl).toHaveBeenCalledOnce();
    expect(url.origin).toBe("ws://127.0.0.1:8233");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("native")).toBe("1");
    expect(url.searchParams.has("token")).toBe(false);
    expect(JSON.parse(ws.send.mock.calls[0][0]).token).toBe("device-token");
  });

  it("resolves the native endpoint again after a Server restart without resending commands", async () => {
    mocks.isElectron.mockReturnValue(true);
    const first = await connect();
    const sending = client.request("message.send", { text: "Run once" });
    const interrupted = expect(sending).rejects.toThrow("Connection closed");
    mocks.getWsUrl.mockResolvedValueOnce("ws://127.0.0.1:8234/ws");
    first.closeFromServer();
    await interrupted;
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeWebSocket.instances.at(-1)!;
    second.open();
    second.authenticate();

    expect(mocks.getWsUrl).toHaveBeenCalledTimes(2);
    expect(first.url).toBe("ws://127.0.0.1:8233/ws");
    expect(second.url).toBe("ws://127.0.0.1:8234/ws");
    expect(second.send).toHaveBeenCalledOnce();
    expect(JSON.parse(second.send.mock.calls[0][0]).type).toBe("auth");
    expect(client.connected).toBe(true);
  });

  it("continues reconnecting while the local Server endpoint is temporarily unavailable", async () => {
    mocks.isElectron.mockReturnValue(true);
    const first = await connect();
    mocks.getWsUrl
      .mockRejectedValueOnce(new Error("Server not ready"))
      .mockRejectedValueOnce(new Error("Server not ready"))
      .mockResolvedValueOnce("ws://127.0.0.1:8235/ws");
    first.closeFromServer();

    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.getWsUrl).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.getWsUrl).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.open();
    replacement.authenticate();

    expect(mocks.getWsUrl).toHaveBeenCalledTimes(4);
    expect(replacement.url).toBe("ws://127.0.0.1:8235/ws");
    expect(client.connected).toBe(true);
  });

  it("retries an initial native endpoint failure before any socket exists", async () => {
    mocks.isElectron.mockReturnValue(true);
    mocks.getWsUrl.mockRejectedValueOnce(new Error("Server not ready"));
    await expect(client.connect()).rejects.toThrow("Server not ready");
    expect(FakeWebSocket.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.authenticate();

    expect(mocks.getWsUrl).toHaveBeenCalledTimes(2);
    expect(client.connected).toBe(true);
  });

  it("keeps an explicit native endpoint across reconnects without resolving IPC", async () => {
    mocks.isElectron.mockReturnValue(true);
    const first = await connect("ws://127.0.0.1:4200/ws?route=explicit");
    first.closeFromServer();
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeWebSocket.instances.at(-1)!;
    second.open();
    second.authenticate();

    expect(second.url).toBe(first.url);
    expect(mocks.getWsUrl).not.toHaveBeenCalled();
    expect(client.connected).toBe(true);
  });

  it("moves explicit endpoint credentials into the authentication frame", async () => {
    mocks.getToken.mockReturnValue("current token/+");

    const ws = await connect("wss://custom.example.test/gateway?route=shared&token=old-token");
    const url = new URL(ws.url);

    expect(url.pathname).toBe("/gateway");
    expect(url.searchParams.get("route")).toBe("shared");
    expect(url.searchParams.has("token")).toBe(false);
    expect(JSON.parse(ws.send.mock.calls[0][0]).token).toBe("current token/+");
  });

  it("reloads the device JWT on reconnect without mutating the saved base URL", async () => {
    const first = await connect("wss://custom.example.test/ws?route=shared");
    mocks.getToken.mockReturnValue("rotated-token");
    first.closeFromServer();
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeWebSocket.instances.at(-1)!;
    second.open();
    second.authenticate();

    expect(new URL(second.url).searchParams.has("token")).toBe(false);
    expect(JSON.parse(second.send.mock.calls[0][0]).token).toBe("rotated-token");
    expect(new URL(second.url).searchParams.get("route")).toBe("shared");

    mocks.getToken.mockReturnValue(null);
    second.closeFromServer();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.connected).toBe(false);
  });

  it("uses explicit credentials without placing them in the WebSocket URL", async () => {
    mocks.getToken.mockReturnValue(null);
    const explicitUrl = "ws://127.0.0.1:4200?token=explicit-test-token";

    const ws = await connect(explicitUrl);

    expect(ws.url).toBe("ws://127.0.0.1:4200/");
    expect(JSON.parse(ws.send.mock.calls[0][0]).token).toBe("explicit-test-token");
    expect(client.connected).toBe(true);
  });

  it("waits for authentication before exposing notifications or accepting commands", async () => {
    const connected = vi.fn();
    const notification = vi.fn();
    client.on("connected", connected);
    client.on("session.created", notification);
    const pending = client.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: "session.created", payload: { session: { id: "private" } } }) });

    expect(client.connected).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    await expect(client.request("engine.list")).rejects.toThrow("Not connected");
    ws.authenticate();
    await pending;
    expect(client.connected).toBe(true);
    expect(connected).toHaveBeenCalledOnce();
  });

  it.each([false, true])("rejects missing credentials without opening or retrying a socket (native=%s)", async (native) => {
    mocks.isElectron.mockReturnValue(native);
    mocks.getToken.mockReturnValue(null);
    await expect(client.connect()).rejects.toThrow("Gateway authentication required");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(mocks.getWsUrl).toHaveBeenCalledTimes(native ? 1 : 0);
  });

  it.each([false, true])("rejects failed authentication without reconnecting (native=%s)", async (native) => {
    mocks.isElectron.mockReturnValue(native);
    const pending = client.connect();
    const rejected = expect(pending).rejects.toThrow("Gateway authentication failed");
    await Promise.resolve();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    const auth = JSON.parse(ws.send.mock.calls[0][0]);
    ws.onmessage?.({ data: JSON.stringify({ type: "response", requestId: auth.requestId, error: { code: "UNAUTHORIZED" }, payload: null }) });
    await rejected;
    expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    ws.onclose?.({ code: 4001, reason: "Unauthorized" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mocks.getWsUrl).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(client.connected).toBe(false);
  });

  it("removes all buffered output for a removed session while preserving other sessions", async () => {
    const ws = await connect();
    const removed = vi.fn();
    const updated = vi.fn();
    const partUpdated = vi.fn();
    const consumed = vi.fn();
    client.on("session.removed", removed);
    client.on("message.updated", updated);
    client.on("message.part.updated", partUpdated);
    client.on("message.queued.consumed", consumed);
    const notify = (type: string, payload: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, payload }) });
    notify("message.updated", { sessionId: "s1", message: { id: "old" } });
    notify("message.part.updated", { sessionId: "s1", part: { id: "old-part", messageId: "old" } });
    notify("message.queued.consumed", { sessionId: "s1", messageId: "old" });
    notify("message.updated", { sessionId: "s2", message: { id: "other" } });
    notify("session.removed", { sessionId: "s1" });
    expect(removed).toHaveBeenCalledExactlyOnceWith({ sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(updated).toHaveBeenCalledExactlyOnceWith({ sessionId: "s2", message: { id: "other" } });
    expect(partUpdated).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });

  it("discards trailing buffered output before a removed session is restored", async () => {
    const ws = await connect();
    const updated = vi.fn();
    client.on("message.updated", updated);
    const notify = (type: string, payload: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, payload }) });
    notify("session.removed", { sessionId: "s1" });
    notify("message.updated", { sessionId: "s1", message: { id: "late" } });
    client.discardSessionNotifications("s1");
    notify("message.updated", { sessionId: "s1", message: { id: "restored" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updated).toHaveBeenCalledExactlyOnceWith({ sessionId: "s1", message: { id: "restored" } });
  });

  it("drops queued updates and parts for a message removed in the same frame", async () => {
    const ws = await connect();
    const removed = vi.fn();
    const updated = vi.fn();
    const partUpdated = vi.fn();
    client.on("message.removed", removed);
    client.on("message.updated", updated);
    client.on("message.part.updated", partUpdated);
    const part = { id: "p1", messageId: "m1", sessionId: "s1", type: "text", text: "old" };
    const notify = (type: string, payload: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, payload }) });

    notify("message.updated", { sessionId: "s1", message: { id: "m1" } });
    notify("message.part.updated", { sessionId: "s1", part });
    notify("message.removed", { sessionId: "s1", messageId: "m1" });
    notify("message.part.updated", { sessionId: "s1", part: { ...part, text: "late old part" } });
    notify("message.part.updated", { sessionId: "s1", part: { ...part, id: "p2", messageId: "m2" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(removed).toHaveBeenCalledWith({ sessionId: "s1", messageId: "m1" });
    expect(updated).not.toHaveBeenCalled();
    expect(partUpdated).toHaveBeenCalledOnce();
    expect(partUpdated.mock.calls[0][0].part.messageId).toBe("m2");
  });

  it("preserves a later explicit recreation after a removal in the same frame", async () => {
    const ws = await connect();
    const order: string[] = [];
    client.on("message.removed", () => order.push("removed"));
    client.on("message.updated", () => order.push("updated"));
    client.on("message.part.updated", () => order.push("part"));
    const notify = (type: string, payload: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, payload }) });
    notify("message.removed", { sessionId: "s1", messageId: "m1" });
    notify("message.updated", { sessionId: "s1", message: { id: "m1" } });
    notify("message.part.updated", { sessionId: "s1", part: { id: "p1", messageId: "m1", text: "new" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["removed", "updated", "part"]);
  });

  it("retains ordinary message ordering and part coalescing without removal events", async () => {
    const ws = await connect();
    const order: string[] = [];
    client.on("message.updated", () => order.push("message"));
    client.on("message.part.updated", ({ part }) => order.push((part as { text: string }).text));
    const part = { id: "p1", messageId: "m1", sessionId: "s1", type: "text", text: "old" };
    const notify = (type: string, payload: unknown) => ws.onmessage?.({ data: JSON.stringify({ type, payload }) });
    notify("message.part.updated", { sessionId: "s1", part });
    notify("message.updated", { sessionId: "s1", message: { id: "m1" } });
    notify("message.part.updated", { sessionId: "s1", part: { ...part, text: "latest" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["message", "latest"]);
  });

  it.each([true, false])("sends the archive RPC and propagates an upstream rejection for archived=%s", async (archived) => {
    const ws = await connect();
    const pending = client.setSessionArchived("s1", archived);
    const rejected = expect(pending).rejects.toThrow("Archive rejected");
    const request = JSON.parse(ws.send.mock.calls.at(-1)![0]);
    expect(request).toMatchObject({ type: "session.archive", payload: { sessionId: "s1", archived } });
    ws.onmessage?.({ data: JSON.stringify({ type: "response", requestId: request.requestId, payload: null, error: { code: "ARCHIVE_FAILED", message: "Archive rejected" } }) });
    await rejected;
  });

  describe("catalog contracts", () => {
    const sourceId = "desktop/local";
    const projectId = "catalog:desktop/local:stable-project";
    const roots = ["/workspace/Second Root", "C:\\Projects\\First", "/workspace/nested/../root"];
    const project: UnifiedProject = { id: projectId, name: "Shared project", directory: roots[0], roots,
      catalogSourceId: sourceId, catalogProjectId: "stable-project" };

    function reply(ws: FakeWebSocket, type: string, payload: unknown, result: unknown): void {
      const request = JSON.parse(ws.send.mock.calls.at(-1)![0]);
      expect(request).toEqual({ type, requestId: expect.any(String), payload });
      ws.onmessage?.({ data: JSON.stringify({ type: "response", requestId: request.requestId, payload: result }) });
    }

    it("lists catalog snapshots without deriving project IDs from roots", async () => {
      const ws = await connect();
      const catalogs: EngineCatalogSnapshot[] = [{ sourceId, revision: "owner-revision", complete: true, projects: [project], sessions: [] }];
      const pending = client.listCatalogs();
      reply(ws, "catalog.list", {}, catalogs);
      expect(await pending).toEqual(catalogs);
    });

    it("creates a project with the source ID and roots unchanged", async () => {
      const ws = await connect();
      const input = { sourceId, name: project.name!, roots };
      const pending = client.createProject(input);
      reply(ws, "project.create", input, project);
      expect(await pending).toEqual(project);
    });

    it("updates and reorders projects by stable ID instead of their working directories", async () => {
      const ws = await connect();
      const patch = { name: "Renamed project", roots: [...roots].reverse() };
      const updated = { ...project, ...patch };
      const updating = client.updateProject({ projectId, patch });
      reply(ws, "project.update", { projectId, patch }, updated);
      expect(await updating).toEqual(updated);
      const projectIds = ["catalog:desktop/local:other-project", projectId];
      const reordering = client.reorderProjects({ sourceId, projectIds });
      reply(ws, "project.reorder", { sourceId, projectIds }, null);
      await reordering;
    });

    it.each([projectId, null])("sends explicit session project assignment %s", async (assignedProjectId) => {
      const ws = await connect();
      const input = { sessionId: "shared-session", projectId: assignedProjectId };
      const pending = client.setSessionProject(input);
      reply(ws, "session.project.set", input, null);
      await pending;
    });

    it("carries a project ID when creating a session without replacing its directory or engine", async () => {
      const ws = await connect();
      const input = { engineType: "codex", directory: "/workspace/worktree", worktreeId: "worktree-stable", projectId };
      const session = { id: "shared-session", ...input, time: { created: 1, updated: 1 } };
      const pending = client.createSession(input);
      reply(ws, "session.create", input, session);
      expect(await pending).toEqual(session);
    });

    it("delivers the catalog snapshot as the direct event payload after authentication", async () => {
      const updated = vi.fn();
      client.on("catalog.updated", updated);
      const pending = client.connect();
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.open();
      const snapshot: EngineCatalogSnapshot = { sourceId, revision: "r2", complete: false, projects: [project], sessions: [] };
      const event = { data: JSON.stringify({ type: "catalog.updated", payload: snapshot }) };
      ws.onmessage?.(event);
      expect(updated).not.toHaveBeenCalled();
      ws.authenticate();
      await pending;
      const sent = ws.send.mock.calls.length;
      ws.onmessage?.(event);
      expect(updated).toHaveBeenCalledExactlyOnceWith(snapshot);
      expect(ws.send).toHaveBeenCalledTimes(sent);
    });
  });

  it("times out a socket that never confirms authentication", async () => {
    const pending = client.connect();
    const rejected = expect(pending).rejects.toThrow("Gateway authentication timed out");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(ws.close).toHaveBeenCalledWith(4000, "Authentication timed out");
    expect(client.connected).toBe(false);
  });

  describe("ensureConnected", () => {
    it("keeps a responsive authenticated socket and coalesces concurrent health checks", async () => {
      const ws = await connect();
      const first = client.ensureConnected();
      const second = client.ensureConnected();
      const request = JSON.parse(ws.send.mock.calls.at(-1)![0]);
      expect(request.type).toBe("engine.list");
      ws.onmessage?.({ data: JSON.stringify({ type: "response", requestId: request.requestId, payload: [] }) });
      await Promise.all([first, second]);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(ws.close).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledTimes(2);
    });

    it("replaces a suspended socket and ignores its delayed close after reauthentication", async () => {
      const old = await connect();
      const recovery = client.ensureConnected();
      await vi.advanceTimersByTimeAsync(5_000);
      const replacement = FakeWebSocket.instances.at(-1)!;
      expect(replacement).not.toBe(old);
      expect(old.close).toHaveBeenCalledWith(4000, "Connection health check failed");
      expect(client.connected).toBe(false);
      replacement.open();
      await expect(client.request("message.send")).rejects.toThrow("Not connected");
      replacement.authenticate();
      await recovery;
      const pending = client.request("engine.list");
      const request = JSON.parse(replacement.send.mock.calls.at(-1)![0]);
      old.closeFromServer();
      expect(client.connected).toBe(true);
      replacement.onmessage?.({ data: JSON.stringify({ type: "response", requestId: request.requestId, payload: [] }) });
      expect(await pending).toEqual([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("waits for an existing connection handshake instead of reporting ready early", async () => {
      const connecting = client.connect();
      const recovery = client.ensureConnected();
      const settled = vi.fn();
      void recovery.then(settled);
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.open();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(1);
      ws.authenticate();
      await Promise.all([connecting, recovery]);
      expect(settled).toHaveBeenCalledOnce();
    });

    it("does not reconnect when the client is explicitly destroyed during a probe", async () => {
      await connect();
      const checking = client.ensureConnected();
      const rejected = expect(checking).rejects.toThrow("Client disconnected");
      client.disconnect();
      await rejected;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it.each(["resolve", "reject"])("does not resume a destroyed connection when native endpoint lookup settles (%s)", async (outcome) => {
      mocks.isElectron.mockReturnValue(true);
      let resolveEndpoint!: (url: string) => void;
      let rejectEndpoint!: (error: Error) => void;
      mocks.getWsUrl.mockReturnValueOnce(new Promise((resolve, reject) => {
        resolveEndpoint = resolve;
        rejectEndpoint = reject;
      }));
      const connecting = client.connect();
      const rejected = expect(connecting).rejects.toThrow(outcome === "resolve" ? "Client disconnected" : "Server not ready");
      client.disconnect();
      if (outcome === "resolve") resolveEndpoint("ws://127.0.0.1:8233/ws");
      else rejectEndpoint(new Error("Server not ready"));
      await rejected;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(mocks.getWsUrl).toHaveBeenCalledOnce();
    });
  });
});
