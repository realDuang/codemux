import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Plugin } from "vite";
import type { RemoteAccessController } from "../shared/remote-access-controller";
import { parseBody, isLocalRequest, sendJson } from "../shared/http-utils";

/** Register host controls before Vite's static and proxy middleware. */
export function createRemoteAccessPlugin(
  controller: RemoteAccessController,
  stopTunnel: () => Promise<void>,
): Plugin {
  return {
    name: "standalone-remote-access",
    async configureServer(server) {
      await controller.initialize();
      const upgrades = new Map<Socket, IncomingMessage>();
      const handleUpgrade = (req: IncomingMessage, socket: Socket) => {
        if (!controller.isRequestAllowed(req, true)) return;
        upgrades.set(socket, req);
        socket.once("close", () => upgrades.delete(socket));
      };
      const unsubscribe = controller.subscribe(() => {
        for (const [socket, req] of upgrades) {
          if (!controller.isRequestAllowed(req, true)) socket.destroy();
        }
      });
      server.httpServer?.on("upgrade", handleUpgrade);
      server.httpServer?.once("close", () => {
        unsubscribe();
        server.httpServer?.off("upgrade", handleUpgrade);
        for (const socket of upgrades.keys()) socket.destroy();
        void stopTunnel().catch(error => {
          console.error("[Remote Access] Failed to stop standalone ingress:", error);
        });
      });

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/remote-access/status" && req.method === "GET") {
          sendJson(res, { mode: controller.getStatus().mode });
          return;
        }
        if (!controller.isRequestAllowed(req)) {
          sendJson(res, { error: "Remote access is disabled for this entry point." }, 403);
          return;
        }
        if (!pathname.startsWith("/api/remote-access") && !pathname.startsWith("/api/tunnel")) {
          next();
          return;
        }
        if (!isLocalRequest(req)) {
          sendJson(res, { error: "Local access only" }, 403);
          return;
        }
        try {
          if (pathname === "/api/remote-access" && req.method === "GET") {
            sendJson(res, controller.getStatus());
          } else if (pathname === "/api/remote-access" && req.method === "PATCH") {
            sendJson(res, await controller.update(await parseBody(req)));
          } else if (pathname === "/api/tunnel/status" && req.method === "GET") {
            sendJson(res, controller.getStatus().tunnel);
          } else if (pathname === "/api/tunnel/start" && req.method === "POST") {
            const body = await parseBody(req);
            const status = await controller.update({
              mode: "cloudflare",
              ...(body.tunnelConfig === undefined ? {} : { tunnelConfig: body.tunnelConfig }),
            });
            sendJson(res, status.tunnel);
          } else if (pathname === "/api/tunnel/stop" && req.method === "POST") {
            if (controller.getStatus().mode === "cloudflare") await controller.update({ mode: "off" });
            sendJson(res, { success: true });
          } else {
            sendJson(res, { error: "Not found" }, 404);
          }
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400);
        }
      });
    },
  };
}
