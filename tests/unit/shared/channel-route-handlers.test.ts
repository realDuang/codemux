import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { EventEmitter } from "events";
import { handleChannelRoutes } from "../../../shared/channel-route-handlers";

describe("channel-route-handlers", () => {
  let mockRes: ServerResponse;
  let mockAuthStore: { verifyToken: ReturnType<typeof vi.fn> };
  let mockChannelManager: {
    listChannels: ReturnType<typeof vi.fn>;
    getConfig: ReturnType<typeof vi.fn>;
    updateConfig: ReturnType<typeof vi.fn>;
    startChannel: ReturnType<typeof vi.fn>;
    stopChannel: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRes = {
      writeHead: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as ServerResponse;

    mockAuthStore = {
      verifyToken: vi.fn(),
    };

    mockChannelManager = {
      listChannels: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      getStatus: vi.fn(),
    };
  });

  const createMockReq = (urlStr: string, method = "GET", body?: unknown) => {
    const req = new EventEmitter() as any;
    req.url = urlStr;
    req.method = method;
    req.headers = {};
    req.socket = { remoteAddress: "127.0.0.1" };
    if (body !== undefined) {
      setTimeout(() => {
        req.emit("data", Buffer.from(JSON.stringify(body)));
        req.emit("end");
      }, 0);
    } else {
      setTimeout(() => req.emit("end"), 0);
    }
    return req as IncomingMessage;
  };

  it("returns false for unrelated routes", async () => {
    const req = createMockReq("/api/other");
    const handled = await handleChannelRoutes(req, mockRes, "/api/other", mockAuthStore, mockChannelManager);
    expect(handled).toBe(false);
  });

  it("requires auth before listing channels", async () => {
    const req = createMockReq("/api/channels");
    const handled = await handleChannelRoutes(req, mockRes, "/api/channels", mockAuthStore, mockChannelManager);
    expect(handled).toBe(true);
    expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("lists channels for authenticated clients", async () => {
    const req = createMockReq("/api/channels");
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });
    mockChannelManager.listChannels.mockReturnValue([{ type: "telegram", status: "running" }]);

    await handleChannelRoutes(req, mockRes, "/api/channels", mockAuthStore, mockChannelManager);

    expect(mockChannelManager.listChannels).toHaveBeenCalled();
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("telegram"));
  });

  it("gets config and status for a specific channel", async () => {
    const authHeaders = { authorization: "Bearer token" };
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    const configReq = createMockReq("/api/channels/telegram");
    configReq.headers = authHeaders;
    mockChannelManager.getConfig.mockReturnValue({ type: "telegram", enabled: true });
    await handleChannelRoutes(configReq, mockRes, "/api/channels/telegram", mockAuthStore, mockChannelManager);
    expect(mockChannelManager.getConfig).toHaveBeenCalledWith("telegram");
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("telegram"));

    const statusReq = createMockReq("/api/channels/telegram/status");
    statusReq.headers = authHeaders;
    mockChannelManager.getStatus.mockReturnValue({ type: "telegram", status: "running" });
    await handleChannelRoutes(statusReq, mockRes, "/api/channels/telegram/status", mockAuthStore, mockChannelManager);
    expect(mockChannelManager.getStatus).toHaveBeenCalledWith("telegram");
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("running"));
  });

  it("redacts secret fields in GET config response and reports secretsConfigured", async () => {
    const req = createMockReq("/api/channels/feishu");
    req.headers = { authorization: "Bearer token" };
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });
    mockChannelManager.getConfig.mockReturnValue({
      type: "feishu",
      options: {
        appId: "cli_visible",
        appSecret: "supersecretvalue",
        botToken: "tk",
        callbackEncodingAESKey: "longaeskey1234",
        normalField: "visible",
      },
    });

    await handleChannelRoutes(req, mockRes, "/api/channels/feishu", mockAuthStore, mockChannelManager);
    const body = JSON.parse((mockRes.end as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? "{}");

    expect(body.options.appId).toBe("cli_visible");
    expect(body.options.appSecret).toBe("");
    expect(body.options.botToken).toBe("");
    expect(body.options.callbackEncodingAESKey).toBe("");
    expect(body.options.normalField).toBe("visible");
    expect(body.options.secretsConfigured).toEqual(
      expect.arrayContaining(["appSecret", "botToken", "callbackEncodingAESKey"])
    );
  });

  it("strips empty secret fields on PUT to prevent overwriting existing values", async () => {
    const req = createMockReq("/api/channels/feishu", "PUT", {
      options: {
        appId: "new-app-id",
        appSecret: "",
        robotCode: "new-code",
      },
    });
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    await handleChannelRoutes(req, mockRes, "/api/channels/feishu", mockAuthStore, mockChannelManager);

    const updateCall = mockChannelManager.updateConfig.mock.calls[0];
    expect(updateCall[0]).toBe("feishu");
    expect(updateCall[1].options.appId).toBe("new-app-id");
    expect(updateCall[1].options.robotCode).toBe("new-code");
    expect(updateCall[1].options).not.toHaveProperty("appSecret");
  });

  it("updates channel config via PUT", async () => {
    const req = createMockReq("/api/channels/teams", "PUT", {
      options: { microsoftAppId: "app-id" },
    });
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    await handleChannelRoutes(req, mockRes, "/api/channels/teams", mockAuthStore, mockChannelManager);

    expect(mockChannelManager.updateConfig).toHaveBeenCalledWith("teams", {
      options: { microsoftAppId: "app-id" },
    });
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("rejects invalid JSON for updates", async () => {
    const req = new EventEmitter() as any;
    req.url = "/api/channels/teams";
    req.method = "PUT";
    req.headers = { authorization: "Bearer token" };
    req.socket = { remoteAddress: "127.0.0.1" };
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });
    setTimeout(() => {
      req.emit("data", Buffer.from("invalid-json"));
      req.emit("end");
    }, 0);

    await handleChannelRoutes(req as IncomingMessage, mockRes, "/api/channels/teams", mockAuthStore, mockChannelManager);

    expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it("starts and stops channels", async () => {
    const authHeaders = { authorization: "Bearer token" };
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    const startReq = createMockReq("/api/channels/wecom/start", "POST");
    startReq.headers = authHeaders;
    await handleChannelRoutes(startReq, mockRes, "/api/channels/wecom/start", mockAuthStore, mockChannelManager);
    expect(mockChannelManager.startChannel).toHaveBeenCalledWith("wecom");

    const stopReq = createMockReq("/api/channels/wecom/stop", "POST");
    stopReq.headers = authHeaders;
    await handleChannelRoutes(stopReq, mockRes, "/api/channels/wecom/stop", mockAuthStore, mockChannelManager);
    expect(mockChannelManager.stopChannel).toHaveBeenCalledWith("wecom");
  });

  it("maps channel manager not-found errors to 404", async () => {
    const req = createMockReq("/api/channels/missing/start", "POST");
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });
    mockChannelManager.startChannel.mockRejectedValue(new Error("Channel adapter 'missing' not found"));

    await handleChannelRoutes(req, mockRes, "/api/channels/missing/start", mockAuthStore, mockChannelManager);

    expect(mockRes.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });
});
