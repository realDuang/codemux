import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { EventEmitter } from "events";
import { handleSettingsRoutes } from "../../../shared/settings-route-handlers";

describe("settings-route-handlers", () => {
  let mockRes: ServerResponse;
  let mockAuthStore: { verifyToken: ReturnType<typeof vi.fn> };
  let mockSettingsStore: {
    getDefaultEngine: ReturnType<typeof vi.fn>;
    saveDefaultEngine: ReturnType<typeof vi.fn>;
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

    mockSettingsStore = {
      getDefaultEngine: vi.fn(),
      saveDefaultEngine: vi.fn(),
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
    const handled = await handleSettingsRoutes(req, mockRes, "/api/other", mockAuthStore, mockSettingsStore);
    expect(handled).toBe(false);
  });

  it("requires auth before reading default engine", async () => {
    const req = createMockReq("/api/settings/default-engine");
    const handled = await handleSettingsRoutes(req, mockRes, "/api/settings/default-engine", mockAuthStore, mockSettingsStore);
    expect(handled).toBe(true);
    expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("returns the persisted default engine for authenticated clients", async () => {
    const req = createMockReq("/api/settings/default-engine");
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });
    mockSettingsStore.getDefaultEngine.mockReturnValue("copilot");

    await handleSettingsRoutes(req, mockRes, "/api/settings/default-engine", mockAuthStore, mockSettingsStore);

    expect(mockSettingsStore.getDefaultEngine).toHaveBeenCalled();
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("copilot"));
  });

  it("updates the persisted default engine via PUT", async () => {
    const req = createMockReq("/api/settings/default-engine", "PUT", { defaultEngine: "copilot" });
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    await handleSettingsRoutes(req, mockRes, "/api/settings/default-engine", mockAuthStore, mockSettingsStore);

    expect(mockSettingsStore.saveDefaultEngine).toHaveBeenCalledWith("copilot");
    expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("rejects missing defaultEngine in PUT payload", async () => {
    const req = createMockReq("/api/settings/default-engine", "PUT", {});
    req.headers.authorization = "Bearer token";
    mockAuthStore.verifyToken.mockReturnValue({ valid: true, deviceId: "device-1" });

    await handleSettingsRoutes(req, mockRes, "/api/settings/default-engine", mockAuthStore, mockSettingsStore);

    expect(mockSettingsStore.saveDefaultEngine).not.toHaveBeenCalled();
    expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });
});
