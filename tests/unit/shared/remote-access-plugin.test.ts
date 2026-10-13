import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { RemoteAccessController } from "../../../shared/remote-access-controller";
import type { RemoteAccessTunnelInfo } from "../../../shared/remote-access";
import { createRemoteAccessPlugin } from "../../../scripts/remote-access-plugin";
import { preserveProxyRequestIdentity } from "../../../scripts/auth-proxy-plugin";

const ENTRY = "http://codemux.example.test";
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createHost() {
  let settings: Record<string, unknown> = { customAccessUrl: ENTRY, remoteAccessMode: "custom" };
  const tunnel = {
    start: vi.fn(async (): Promise<RemoteAccessTunnelInfo> => ({ status: "running", url: "https://cf.example.test" })),
    stop: vi.fn(async () => undefined),
    getInfo: (): RemoteAccessTunnelInfo => ({ status: "stopped", url: "" }),
  };
  const controller = new RemoteAccessController({
    loadSettings: () => settings,
    saveSettings: patch => { settings = { ...settings, ...patch }; },
    tunnel,
    getPort: () => 8234,
  });
  const root = await mkdtemp(path.join(tmpdir(), "codemux-access-plugin-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "<html>CodeMux remote access fixture</html>");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  cleanup.push(() => new Promise<void>(resolve => {
    for (const ws of upstream.clients) ws.terminate();
    upstream.close(() => resolve());
  }));
  const address = upstream.address();
  if (typeof address === "string") throw new Error("Expected TCP server.");
  const stopTunnel = vi.fn(async () => undefined);
  const server: ViteDevServer = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [createRemoteAccessPlugin(controller, stopTunnel)],
    server: {
      port: 0,
      host: "127.0.0.1",
      hmr: false,
      allowedHosts: true,
      proxy: {
        "/ws": {
          target: `http://127.0.0.1:${address.port}`,
          ws: true,
          bypass: req => controller.isRequestAllowed(req, true) ? undefined : false,
          configure: proxy => {
            proxy.on("proxyReq", preserveProxyRequestIdentity);
            proxy.on("proxyReqWs", preserveProxyRequestIdentity);
          },
        },
      },
    },
  });
  cleanup.push(() => server.close());
  await server.listen();
  const webAddress = server.httpServer?.address();
  if (!webAddress || typeof webAddress === "string") throw new Error("Expected Vite TCP server.");
  return { controller, port: webAddress.port, upstream, server, stopTunnel, getSettings: () => settings };
}

function request(port: number, pathname: string, remote = false, method = "GET", body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: pathname, method,
      headers: remote
        ? { host: "codemux.example.test", origin: ENTRY, "x-forwarded-for": "192.0.2.50", "content-type": "application/json" }
        : { "content-type": "application/json" },
    }, res => {
      let response = "";
      res.on("data", chunk => { response += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("createRemoteAccessPlugin", () => {
  it("keeps host controls private and serves minimal disabled status remotely", async () => {
    const host = await createHost();
    expect((await request(host.port, "/", true)).status).toBe(200);
    expect((await request(host.port, "/api/remote-access", true)).status).toBe(403);
    expect((await request(host.port, "/api/tunnel/start", true, "POST")).status).toBe(403);
    expect((await request(host.port, "/api/remote-access", false, "PATCH", { mode: "off" })).status).toBe(200);
    expect((await request(host.port, "/", true)).status).toBe(403);
    expect((await request(host.port, "/", false)).status).toBe(200);
    const status = await request(host.port, "/api/remote-access/status", true);
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ mode: "off" });
  });

  it("passes remote WS identity and disconnects its existing socket when disabled", async () => {
    const host = await createHost();
    const connection = once(host.upstream, "connection");
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, {
      headers: { host: "codemux.example.test", origin: ENTRY, "x-forwarded-for": "192.0.2.50" },
    });
    cleanup.push(async () => ws.terminate());
    await once(ws, "open");
    const [, req] = await connection;
    expect(req.headers.host).toBe("codemux.example.test");
    expect(req.headers["x-forwarded-for"]).toBe("192.0.2.50, 127.0.0.1");
    const closed = once(ws, "close");
    await host.controller.update({ mode: "off" });
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("preserves local desktop WS while off and rejects a remote upgrade", async () => {
    const host = await createHost();
    await host.controller.update({ mode: "off" });
    const local = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, { origin: "null" });
    cleanup.push(async () => local.terminate());
    await once(local, "open");
    expect(local.readyState).toBe(WebSocket.OPEN);
    const remote = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, {
      headers: { host: "codemux.example.test", origin: ENTRY },
    });
    remote.on("error", () => undefined);
    cleanup.push(async () => remote.terminate());
    const rejection = await once(remote, "unexpected-response");
    expect(rejection[1].statusCode).toBe(404);
    rejection[1].resume();
  });

  it("stops the connector on server close without erasing the selected mode", async () => {
    const host = await createHost();
    await host.server.close();
    expect(host.stopTunnel).toHaveBeenCalledOnce();
    expect(host.getSettings().remoteAccessMode).toBe("custom");
  });
});
