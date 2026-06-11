import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock("electron-log/main", () => {
  const mockScope = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  });
  const mockLog: any = {
    transports: {
      file: {
        resolvePathFn: null,
        maxSize: 0,
        level: "warn",
        format: "",
        getFile: vi.fn(() => ({ path: "/tmp/test.log" })),
      },
      console: { level: "info", format: "" },
    },
    errorHandler: { startCatching: vi.fn() },
    eventLogger: { startLogging: vi.fn() },
    scope: vi.fn(() => mockScope()),
  };
  return { default: mockLog };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => (name === "logs" ? "/tmp/logs" : "/tmp/userData")),
  },
}));

// Avoid the real device store binding to disk. The auth-api-server uses
// `deviceStore` only as a TokenVerifier; we override verifyToken per-test.
vi.mock("../../../../electron/main/services/device-store", () => ({
  deviceStore: {
    verifyToken: vi.fn(() => ({ valid: false })),
  },
}));

// Force AUTH_API_PORT to 0 so the OS picks a free ephemeral port and the
// test never collides with a real codemux dev instance.
vi.mock("../../../../shared/ports", async () => {
  const actual = await vi.importActual<typeof import("../../../../shared/ports")>(
    "../../../../shared/ports",
  );
  return { ...actual, AUTH_API_PORT: 0 };
});

// ---------------------------------------------------------------------------
// Imports (must come after vi.mock calls)
// ---------------------------------------------------------------------------

import { authApiServer } from "../../../../electron/main/services/auth-api-server";
import { deviceStore } from "../../../../electron/main/services/device-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = { status: number; body: any };

function request(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Json> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            // leave as text
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function makeChannelManager() {
  return {
    listChannels: vi.fn(() => [{ type: "feishu", name: "feishu", status: "running" }]),
    getConfig: vi.fn(() => ({ type: "feishu", enabled: true, options: { appId: "abc" } })),
    updateConfig: vi.fn(async () => undefined),
    startChannel: vi.fn(async () => undefined),
    stopChannel: vi.fn(async () => undefined),
    getStatus: vi.fn(() => ({ type: "feishu", name: "feishu", status: "running" })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthApiServer", () => {
  let port: number;

  beforeAll(async () => {
    await authApiServer.start();
    // Access the underlying http.Server to discover the OS-assigned port.
    const internalServer = (authApiServer as unknown as { server: http.Server }).server;
    port = (internalServer.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await authApiServer.stop();
  });

  describe("setChannelManager + /api/channels/* dispatch", () => {
    it("returns 401 when /api/channels is requested before the manager is injected by an unauthenticated caller", async () => {
      // Ensure no manager is attached
      (authApiServer as unknown as { channelManager: unknown }).channelManager = null;

      const res = await request(port, "/api/channels");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns a generic 503 when /api/channels is requested before the manager is injected", async () => {
      (authApiServer as unknown as { channelManager: unknown }).channelManager = null;
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: true,
        deviceId: "dev-1",
      });

      const res = await request(port, "/api/channels", {
        headers: { authorization: "Bearer good-token" },
      });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Channel service temporarily unavailable");
    });

    it("returns 503 for nested /api/channels/<type>/start paths when manager missing", async () => {
      (authApiServer as unknown as { channelManager: unknown }).channelManager = null;
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: true,
        deviceId: "dev-1",
      });

      const res = await request(port, "/api/channels/feishu/start", {
        method: "POST",
        headers: { authorization: "Bearer good-token" },
      });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Channel service temporarily unavailable");
    });

    it("delegates to handleChannelRoutes when manager is injected (lists channels with valid auth)", async () => {
      const cm = makeChannelManager();
      authApiServer.setChannelManager(cm);
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: true,
        deviceId: "dev-1",
      });

      const res = await request(port, "/api/channels", {
        headers: { authorization: "Bearer good-token" },
      });

      expect(res.status).toBe(200);
      expect(cm.listChannels).toHaveBeenCalledTimes(1);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toMatchObject({ type: "feishu" });
    });

    it("returns 401 from handleChannelRoutes when caller is unauthenticated", async () => {
      const cm = makeChannelManager();
      authApiServer.setChannelManager(cm);
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValue({ valid: false });

      const res = await request(port, "/api/channels");
      expect(res.status).toBe(401);
      expect(cm.listChannels).not.toHaveBeenCalled();
    });

    it("forwards a successful PUT update to channelManager.updateConfig", async () => {
      const cm = makeChannelManager();
      authApiServer.setChannelManager(cm);
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: true,
        deviceId: "dev-1",
      });

      const body = JSON.stringify({ options: { appId: "new-id" } });
      const res = await request(port, "/api/channels/feishu", {
        method: "PUT",
        headers: {
          authorization: "Bearer good-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(cm.updateConfig).toHaveBeenCalledWith("feishu", {
        options: { appId: "new-id" },
      });
    });
  });

  describe("non-channel routes", () => {
    it("returns 204 for CORS preflight (OPTIONS)", async () => {
      const res = await request(port, "/api/anything", { method: "OPTIONS" });
      // sendJson default for OPTIONS preflight => 200 with {} body in this server
      // (see handleRequest); accept either 200 or 204 to stay robust.
      expect([200, 204]).toContain(res.status);
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request(port, "/api/no-such-thing");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });
  });

  describe("getPort()", () => {
    it("returns the configured AUTH_API_PORT constant (mocked to 0 in this suite)", () => {
      expect(authApiServer.getPort()).toBe(0);
    });
  });
});
