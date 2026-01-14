import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import fs from "fs";
import path from "path";
import os from "os";
import { tunnelManager } from "./scripts/tunnel-manager";

export default defineConfig({
  plugins: [
    solid(),
    {
      name: "custom-api-middleware",
      configureServer(server) {
        // 验证码验证端点
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/auth/verify") {
            next();
            return;
          }
          if (req.method !== "POST") {
            // @ts-ignore
            res.statusCode = 405;
            res.end();
            return;
          }

          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const { code } = JSON.parse(body);
              const authCodePath = path.join(process.cwd(), ".auth-code");

              if (!fs.existsSync(authCodePath)) {
                // @ts-ignore
                res.statusCode = 500;
                res.end(JSON.stringify({ error: "Auth code not found" }));
                return;
              }

              const validCode = fs.readFileSync(authCodePath, "utf-8").trim();

              if (code === validCode) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ success: true, token: validCode }));
              } else {
                // @ts-ignore
                res.statusCode = 401;
                res.end(JSON.stringify({ error: "Invalid code" }));
              }
            } catch (err) {
              // @ts-ignore
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "Bad request" }));
            }
          });
        });

        // 获取访问码端点
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/auth/code") {
            next();
            return;
          }
          if (req.method !== "GET") {
            next();
            return;
          }

          try {
            const authCodePath = path.join(process.cwd(), ".auth-code");
            if (fs.existsSync(authCodePath)) {
              const code = fs.readFileSync(authCodePath, "utf-8").trim();
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ code }));
            } else {
              // @ts-ignore
              res.statusCode = 404;
              res.end(JSON.stringify({ error: "Code not found" }));
            }
          } catch (err) {
            // @ts-ignore
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Server error" }));
          }
        });

        // 获取系统信息端点
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/api/system/info") {
            next();
            return;
          }
          if (req.method !== "GET") {
            next();
            return;
          }

          try {
            // 获取局域网IP
            let localIp = "localhost";
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
              const nets = interfaces[name];
              if (!nets) continue;
              for (const net of nets) {
                if (net.family === "IPv4" && !net.internal) {
                  localIp = net.address;
                  break;
                }
              }
              if (localIp !== "localhost") break;
            }

            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                localIp,
                port: 5174,
              }),
            );
          } catch (err) {
            // @ts-ignore
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Server error" }));
          }
        });

        // Tunnel管理API - 统一处理
        server.middlewares.use(async (req, res, next) => {
          // 只处理 /api/tunnel 路径
          if (!req.url?.startsWith("/api/tunnel")) {
            next();
            return;
          }

          res.setHeader("Content-Type", "application/json");

          try {
            if (req.url === "/api/tunnel/start" && req.method === "POST") {
              const info = await tunnelManager.start(5174);
              res.end(JSON.stringify(info));
              return;
            }

            if (req.url === "/api/tunnel/stop" && req.method === "POST") {
              await tunnelManager.stop();
              res.end(JSON.stringify({ success: true }));
              return;
            }

            if (req.url === "/api/tunnel/status" && req.method === "GET") {
              const info = tunnelManager.getInfo();
              res.end(JSON.stringify(info));
              return;
            }

            // 未匹配到具体路由
            // @ts-ignore
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Not found" }));
          } catch (error: any) {
            console.error("[API Error]", error);
            // @ts-ignore
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      },
    },
  ],
  server: {
    port: 5174,
    host: true, // 允许外部访问
    allowedHosts: [
      "localhost",
      ".trycloudflare.com", // 允许所有 Cloudflare Tunnel 域名
    ],
    proxy: {
      "/opencode-api": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
      },
      // Keep SSE connection open
      "/opencode-api/global/event": {
        target: "http://localhost:4096",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/opencode-api/, ""),
        timeout: 0,
      },
    },
  },
});
