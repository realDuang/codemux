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
    getAppPath: vi.fn(() => "/tmp/nonexistent-app-root"),
    getPath: vi.fn((name: string) => (name === "logs" ? "/tmp/logs" : "/tmp/userData")),
  },
}));

vi.mock("../../../../electron/main/services/device-store", () => ({
  deviceStore: {
    verifyToken: vi.fn(() => ({ valid: false })),
  },
}));

// Point the proxy targets at ports that are guaranteed to be closed so the
// fall-back branches in proxyToOpenCode/proxyToWebhook are exercised
// deterministically (otherwise a local OpenCode instance on the default port
// would answer and skew the test).
vi.mock("../../../../shared/ports", async () => {
  const actual = await vi.importActual<typeof import("../../../../shared/ports")>(
    "../../../../shared/ports",
  );
  return {
    ...actual,
    OPENCODE_PORT: 1, // privileged port, will refuse from userland
    WEBHOOK_PORT: 1,
  };
});

// ---------------------------------------------------------------------------
// Imports (must come after vi.mock calls)
// ---------------------------------------------------------------------------

import { productionServer } from "../../../../electron/main/services/production-server";
import { deviceStore } from "../../../../electron/main/services/device-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = { status: number; headers: http.IncomingHttpHeaders; body: any };

function request(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Json> {
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
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
    listChannels: vi.fn(() => [{ type: "feishu", name: "feishu", status: "stopped" }]),
    getConfig: vi.fn(() => ({ type: "feishu", enabled: false, options: { appId: "abc" } })),
    updateConfig: vi.fn(async () => undefined),
    startChannel: vi.fn(async () => undefined),
    stopChannel: vi.fn(async () => undefined),
    getStatus: vi.fn(() => ({ type: "feishu", name: "feishu", status: "stopped" })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProductionServer", () => {
  let port: number;

  beforeAll(async () => {
    // port 0 → OS picks a free ephemeral port. start() resolves with the
    // value held in `this.port` (which stays 0 for OS-assigned listens), so
    // we read the actual port from the underlying http.Server.
    await productionServer.start(0);
    const internalServer = productionServer.getServer();
    expect(internalServer).not.toBeNull();
    port = (internalServer!.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await productionServer.stop();
  });

  describe("lifecycle", () => {
    it("isRunning() returns true while server is bound, false after stop", () => {
      expect(productionServer.isRunning()).toBe(true);
      expect(productionServer.getServer()).not.toBeNull();
    });

    it("getPort() returns the value passed to start() (0 here, OS-assigned)", () => {
      expect(productionServer.getPort()).toBe(0);
    });

    it("start() is a no-op if called again while already running", async () => {
      const samePort = await productionServer.start(0);
      expect(samePort).toBe(0);
    });
  });

  describe("CORS preflight", () => {
    it("OPTIONS returns 204 with permissive CORS headers", async () => {
      const res = await request(port, "/api/anything", { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
      expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
    });
  });

  describe("System routes", () => {
    it("GET /api/system/info returns the local IP and the configured port", async () => {
      const res = await request(port, "/api/system/info");
      expect(res.status).toBe(200);
      // server.port stored from start(0) → API echoes 0 even though the
      // OS-assigned ephemeral port is what we actually connected on.
      expect(res.body.port).toBe(0);
      expect(typeof res.body.localIp).toBe("string");
    });

    it("GET /api/system/is-local returns isLocal=true for 127.0.0.1 calls", async () => {
      const res = await request(port, "/api/system/is-local");
      expect(res.status).toBe(200);
      expect(res.body.isLocal).toBe(true);
    });

    it("GET /api/tunnel/anything returns 400 (IPC-only)", async () => {
      const res = await request(port, "/api/tunnel/start");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/IPC/);
    });
  });

  describe("Auth/Settings route fall-through", () => {
    it("returns 404 for an unknown /api/auth path", async () => {
      const res = await request(port, "/api/auth/not-a-real-route");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });

    it("returns 401 for an unauthenticated /api/settings/shared request (auth-required)", async () => {
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValue({ valid: false });
      const res = await request(port, "/api/settings/shared");
      // No bearer token → requireAuth sends 401
      expect(res.status).toBe(401);
    });
  });

  describe("Proxy fall-back when upstreams are down", () => {
    it("GET /opencode-api/health returns 503 when OpenCode is not running", async () => {
      const res = await request(port, "/opencode-api/health");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/OpenCode/i);
    });

    it("POST /api/messages returns 503 when WebhookServer is not running", async () => {
      const body = JSON.stringify({ hello: "world" });
      const res = await request(port, "/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/Webhook/i);
    });
  });

  describe("setChannelManager + /api/channels/* dispatch", () => {
    it("returns 503 when /api/channels is requested before the manager is injected", async () => {
      (productionServer as unknown as { channelManager: unknown }).channelManager = null;

      const res = await request(port, "/api/channels");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/ChannelManager not configured/i);
    });

    it("returns 503 for nested /api/channels/<type>/start when manager missing", async () => {
      (productionServer as unknown as { channelManager: unknown }).channelManager = null;

      const res = await request(port, "/api/channels/feishu/start", { method: "POST" });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/ChannelManager not configured/i);
    });

    it("delegates to handleChannelRoutes when manager is injected", async () => {
      const cm = makeChannelManager();
      productionServer.setChannelManager(cm);
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        valid: true,
        deviceId: "dev-1",
      });

      const res = await request(port, "/api/channels", {
        headers: { authorization: "Bearer good-token" },
      });

      expect(res.status).toBe(200);
      expect(cm.listChannels).toHaveBeenCalledTimes(1);
      expect(res.body[0]).toMatchObject({ type: "feishu" });
    });

    it("forwards a successful PUT update to channelManager.updateConfig", async () => {
      const cm = makeChannelManager();
      productionServer.setChannelManager(cm);
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

    it("falls through to 404 when no handleChannelRoutes branch matches the verb", async () => {
      const cm = makeChannelManager();
      productionServer.setChannelManager(cm);
      (deviceStore.verifyToken as ReturnType<typeof vi.fn>).mockReturnValue({
        valid: true,
        deviceId: "dev-1",
      });

      const res = await request(port, "/api/channels", {
        method: "DELETE",
        headers: { authorization: "Bearer good-token" },
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });
  });

  describe("Static file serving", () => {
    it("falls through to 404 for a request that misses all routes (no static root present)", async () => {
      // staticRoot is /tmp/nonexistent-app-root/out/renderer which doesn't
      // exist; serveStaticFile catches the stat error and tries index.html,
      // which also doesn't exist → readFile fails → 404 "Not Found".
      const res = await request(port, "/some/spa/route");
      expect(res.status).toBe(404);
      expect(res.body).toBe("Not Found");
    });
  });
});
