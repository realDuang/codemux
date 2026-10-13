import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { AddressInfo } from "node:net";
import type { RemoteAccessTunnelInfo } from "../../../../shared/remote-access";

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

const remoteAccessFixture = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  tunnelInfo: { status: "stopped", url: "" } as RemoteAccessTunnelInfo,
}));

// Exercise the real controller, routes, and admission checks without reading
// the user's settings or starting a cloudflared child process.
vi.mock("../../../../electron/main/services/remote-access-manager", async () => {
  const { RemoteAccessController } = await vi.importActual<typeof import("../../../../shared/remote-access-controller")>(
    "../../../../shared/remote-access-controller",
  );
  return {
    remoteAccessManager: new RemoteAccessController({
      loadSettings: () => remoteAccessFixture.settings,
      saveSettings: patch => { remoteAccessFixture.settings = { ...remoteAccessFixture.settings, ...patch }; },
      getPort: () => 8233,
      tunnel: {
        getInfo: () => remoteAccessFixture.tunnelInfo,
        stop: async () => { remoteAccessFixture.tunnelInfo = { status: "stopped", url: "" }; },
        start: async (_port, config) => {
          remoteAccessFixture.tunnelInfo = { status: "running", url: `https://${config?.hostname || "test.trycloudflare.com"}` };
          return remoteAccessFixture.tunnelInfo;
        },
      },
    }),
  };
});

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
import { remoteAccessManager } from "../../../../electron/main/services/remote-access-manager";

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
  let appRoot: string;
  const webIndex = "<!doctype html><title>CodeMux Web</title>";

  beforeAll(async () => {
    appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codemux-production-server-"));
    vi.mocked(app.getAppPath).mockReturnValue(appRoot);
    const webRoot = path.join(appRoot, "out", "web");
    await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
    await fs.mkdir(path.join(appRoot, "out", "renderer"), { recursive: true });
    await fs.mkdir(path.join(appRoot, "out", "web-private"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(webRoot, "index.html"), webIndex),
      fs.writeFile(path.join(webRoot, "sw.js"), "self.addEventListener('install', () => {});"),
      fs.writeFile(path.join(webRoot, "manifest.webmanifest"), JSON.stringify({ name: "CodeMux" })),
      fs.writeFile(path.join(webRoot, "workbox-a1b2c3d4.js"), "/* Workbox runtime */"),
      fs.writeFile(path.join(webRoot, "assets", "index-A1b2C3d4.js"), "console.log('web');"),
      fs.writeFile(path.join(webRoot, "assets", "page-A1b2C3d4.html"), webIndex),
      fs.writeFile(path.join(webRoot, "assets", "logo.png"), "image fixture"),
      fs.writeFile(path.join(webRoot, "assets", "file with spaces.txt"), "decoded pathname"),
      fs.writeFile(path.join(appRoot, "out", "renderer", "index.html"), "Electron renderer"),
      fs.writeFile(path.join(appRoot, "out", "web-private", "private.txt"), "outside static root"),
    ]);
    await fs.symlink(path.join(appRoot, "out", "web-private"), path.join(webRoot, "linked"), "junction");

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
    await fs.rm(appRoot, { recursive: true, force: true });
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

    it("rejects an unsupported method on tunnel controls", async () => {
      const res = await request(port, "/api/tunnel/start");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Not found");
    });
  });

  describe("Remote access controls and admission", () => {
    const customUrl = "http://192.168.31.123:18233";
    const remoteHeaders = { host: "192.168.31.123:18233", "x-forwarded-for": "192.168.31.2" };

    beforeEach(async () => {
      await remoteAccessManager.update({ mode: "off", customAccessUrl: "", tunnelConfig: { hostname: "" } });
    });

    it("exposes only the current mode remotely while retaining complete configuration for the local host", async () => {
      await remoteAccessManager.update({ mode: "custom", customAccessUrl: customUrl, tunnelConfig: { hostname: "codemux.example.com" } });

      const publicStatus = await request(port, "/api/remote-access/status", { headers: remoteHeaders });
      expect(publicStatus.status).toBe(200);
      expect(publicStatus.body).toEqual({ mode: "custom" });

      const remoteConfig = await request(port, "/api/remote-access", { headers: remoteHeaders });
      expect(remoteConfig.status).toBe(403);
      expect(remoteConfig.body).toEqual({ error: "Local access only" });

      const localConfig = await request(port, "/api/remote-access");
      expect(localConfig.status).toBe(200);
      expect(localConfig.body).toMatchObject({
        mode: "custom", customAccessUrl: customUrl, url: customUrl,
        tunnelConfig: { hostname: "codemux.example.com" },
        tunnel: { status: "stopped", url: "" },
      });
    });

    it("rejects an approved remote device that forges a localhost Host when reading or mutating access controls", async () => {
      await remoteAccessManager.update({ mode: "custom", customAccessUrl: customUrl });
      vi.mocked(deviceStore.verifyToken).mockReturnValue({ valid: true, deviceId: "approved-device" });
      const headers = {
        host: `localhost:${port}`,
        "x-forwarded-for": "192.168.31.2",
        authorization: "Bearer approved-device-token",
        "content-type": "application/json",
      };

      for (const path of ["/api/remote-access", "/api/tunnel/status"]) {
        const res = await request(port, path, { headers });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Local access only" });
      }
      const update = await request(port, "/api/remote-access", { method: "PATCH", headers, body: JSON.stringify({ mode: "off" }) });
      expect(update.status).toBe(403);
      expect(update.body).toEqual({ error: "Local access only" });
      expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "custom", url: customUrl });
      expect(remoteAccessFixture.settings.remoteAccessMode).toBe("custom");
    });

    it("enables and withdraws remote HTTP admission through the local PATCH endpoint", async () => {
      const blocked = await request(port, "/api/system/info", { headers: remoteHeaders });
      expect(blocked.status).toBe(403);

      const enabled = await request(port, "/api/remote-access", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "custom", customAccessUrl: customUrl }),
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body).toMatchObject({ mode: "custom", url: customUrl });
      expect((await request(port, "/api/system/info", { headers: remoteHeaders })).status).toBe(200);

      const disabled = await request(port, "/api/remote-access", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "off" }),
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body).toMatchObject({ mode: "off", url: "", customAccessUrl: customUrl });
      expect((await request(port, "/api/system/info", { headers: remoteHeaders })).status).toBe(403);
      expect((await request(port, "/api/remote-access/status", { headers: remoteHeaders })).body).toEqual({ mode: "off" });
      expect((await request(port, "/api/system/info")).status).toBe(200);
    });

    it("returns a failed update without changing a working custom entry", async () => {
      await remoteAccessManager.update({ mode: "custom", customAccessUrl: customUrl });
      const res = await request(port, "/api/remote-access", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "custom", customAccessUrl: "https://codemux.example.com/path" }),
      });

      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
      expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "custom", url: customUrl });
      expect((await request(port, "/api/system/info", { headers: remoteHeaders })).status).toBe(200);
    });

    it("routes legacy tunnel start and stop through the same mutually exclusive access mode", async () => {
      await remoteAccessManager.update({ mode: "custom", customAccessUrl: customUrl });
      const started = await request(port, "/api/tunnel/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tunnelConfig: { hostname: "codemux.example.com" } }),
      });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ status: "running", url: "https://codemux.example.com" });
      expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "cloudflare", customAccessUrl: customUrl });
      expect((await request(port, "/api/system/info", { headers: remoteHeaders })).status).toBe(403);
      expect((await request(port, "/api/system/info", { headers: { host: "codemux.example.com", origin: "https://codemux.example.com" } })).status).toBe(200);

      const stopped = await request(port, "/api/tunnel/stop", { method: "POST" });
      expect(stopped.status).toBe(200);
      expect(stopped.body).toEqual({ success: true });
      expect(remoteAccessManager.getStatus()).toMatchObject({ mode: "off", customAccessUrl: customUrl, tunnel: { status: "stopped" } });
      expect((await request(port, "/api/system/info", { headers: { host: "codemux.example.com" } })).status).toBe(403);
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
    it("rejects unauthenticated access to the engine proxy", async () => {
      const res = await request(port, "/opencode-api/health");
      expect(res.status).toBe(401);
    });

    it("GET /opencode-api/health returns 503 when OpenCode is not running", async () => {
      vi.mocked(deviceStore.verifyToken).mockReturnValueOnce({ valid: true, deviceId: "approved-device" });
      const res = await request(port, "/opencode-api/health", {
        headers: { Authorization: "Bearer approved-device-token" },
      });
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
    it("returns 401 when /api/channels is requested before the manager is injected by an unauthenticated caller", async () => {
      (productionServer as unknown as { channelManager: unknown }).channelManager = null;

      const res = await request(port, "/api/channels");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns a generic 503 when /api/channels is requested before the manager is injected", async () => {
      (productionServer as unknown as { channelManager: unknown }).channelManager = null;
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

    it("returns 503 for nested /api/channels/<type>/start when manager missing", async () => {
      (productionServer as unknown as { channelManager: unknown }).channelManager = null;
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
    it("serves the independent web build with revalidated HTML", async () => {
      const res = await request(port, "/");
      expect(res.status).toBe(200);
      expect(res.body).toBe(webIndex);
      expect(res.headers).toMatchObject({
        "content-type": "text/html",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
    });

    it.each(["/chat?session=session-1", "/settings", "/devices/", "/remote", "/login"])("serves the web entry for HTML navigation to %s", async (pathname) => {
      const res = await request(port, pathname, { headers: { accept: "text/html,application/xhtml+xml" } });
      expect(res.status).toBe(200);
      expect(res.body).toBe(webIndex);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it.each([
      ["/sw.js", "application/javascript", "no-cache"],
      ["/manifest.webmanifest", "application/manifest+json", "no-cache"],
      ["/assets/logo.png", "image/png", "no-cache"],
      ["/assets/page-A1b2C3d4.html", "text/html", "no-cache"],
      ["/assets/index-A1b2C3d4.js", "application/javascript", "public, max-age=31536000, immutable"],
      ["/workbox-a1b2c3d4.js", "application/javascript", "public, max-age=31536000, immutable"],
    ])("serves %s with its MIME type and cache policy", async (pathname, contentType, cacheControl) => {
      const res = await request(port, pathname);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(contentType);
      expect(res.headers["cache-control"]).toBe(cacheControl);
    });

    it("returns headers without a response body for HEAD navigation", async () => {
      const res = await request(port, "/chat", { method: "HEAD", headers: { accept: "text/html" } });
      expect(res.status).toBe(200);
      expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(webIndex)));
      expect(res.body).toBeUndefined();
    });

    it.each(["/assets/missing.js", "/missing.webmanifest", "/missing-sw.js", "/ws", "/some/spa/route"])("returns 404 rather than HTML for missing resource %s", async (pathname) => {
      const res = await request(port, pathname, { headers: { accept: "text/html" } });
      expect(res.status).toBe(404);
      expect(res.body).toBe("Not Found");
    });

    it.each(["/api", "/api/unknown"])("returns a JSON 404 for unmatched API %s", async (pathname) => {
      const res = await request(port, pathname, { headers: { accept: "text/html" } });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
      expect(res.headers["content-type"]).toBe("application/json");
    });

    it("does not use SPA fallback for data requests or unsupported methods", async () => {
      const dataRequest = await request(port, "/chat", { headers: { accept: "application/json" } });
      const postRequest = await request(port, "/chat", { method: "POST", headers: { accept: "text/html" } });
      expect(dataRequest.status).toBe(404);
      expect(postRequest.status).toBe(404);
    });

    it("decodes ordinary escaped pathnames", async () => {
      const res = await request(port, "/assets/file%20with%20spaces.txt");
      expect(res.status).toBe(200);
      expect(res.body).toBe("decoded pathname");
    });

    it.each(["/%E0%A4%A", "/assets/%00.js", "/..%5Cweb-private%5Cprivate.txt"])("rejects malformed pathname %s", async (pathname) => {
      const res = await request(port, pathname);
      expect(res.status).toBe(400);
    });

    it.each(["/..%2Fweb-private%2Fprivate.txt", "/linked/private.txt"])("rejects paths outside the web build: %s", async (pathname) => {
      const res = await request(port, pathname);
      expect(res.status).toBe(403);
      expect(res.body).toBe("Forbidden");
    });

    it("applies remote admission before serving the PWA shell or assets", async () => {
      await remoteAccessManager.update({ mode: "off" });
      const headers = { host: "codemux.example.com", "x-forwarded-for": "192.168.31.2", accept: "text/html" };
      for (const pathname of ["/", "/chat", "/sw.js", "/manifest.webmanifest"]) {
        const res = await request(port, pathname, { headers });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Remote access is disabled for this entry point.");
      }
    });
  });
});
