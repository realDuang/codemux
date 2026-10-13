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

  it("rejects missing credentials without opening a socket", async () => {
    mocks.getToken.mockReturnValue(null);
    await expect(client.connect()).rejects.toThrow("Gateway authentication required");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects a failed authentication response and does not reconnect after rejection", async () => {
    const pending = client.connect();
    const rejected = expect(pending).rejects.toThrow("Gateway authentication failed");
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    const auth = JSON.parse(ws.send.mock.calls[0][0]);
    ws.onmessage?.({ data: JSON.stringify({ type: "response", requestId: auth.requestId, error: { code: "UNAUTHORIZED" }, payload: null }) });
    await rejected;
    expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized");
    ws.onclose?.({ code: 4001, reason: "Unauthorized" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.connected).toBe(false);
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

    it("does not open an old native endpoint after the connection is destroyed", async () => {
      mocks.isElectron.mockReturnValue(true);
      let resolveEndpoint!: (url: string) => void;
      mocks.getWsUrl.mockReturnValueOnce(new Promise((resolve) => { resolveEndpoint = resolve; }));
      const connecting = client.connect();
      const rejected = expect(connecting).rejects.toThrow("Client disconnected");
      client.disconnect();
      resolveEndpoint("ws://127.0.0.1:8233/ws");
      await rejected;
      expect(FakeWebSocket.instances).toHaveLength(0);
    });
  });
});
