import { defineConfig, mergeConfig } from "vite";
import webConfig from "./vite.web.config";
import { createAuthProxyPlugin, isElectronRemoteRequestAllowed, preserveProxyRequestIdentity } from "./scripts/auth-proxy-plugin";
import { GATEWAY_PORT, WEBHOOK_PORT, WEB_PORT } from "./shared/ports";

// Development uses the same Web app and host-owned auth store as production.
export default defineConfig(mergeConfig(webConfig, defineConfig({
  plugins: [createAuthProxyPlugin({ defaultPort: WEB_PORT })],
  server: {
    hmr: false,
    host: true,
    port: WEB_PORT,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: `http://localhost:${GATEWAY_PORT}`,
        ws: true,
        bypass: async req => await isElectronRemoteRequestAllowed(req, true) ? undefined : false,
        configure: proxy => {
          proxy.on("proxyReq", preserveProxyRequestIdentity);
          proxy.on("proxyReqWs", preserveProxyRequestIdentity);
        },
      },
      "/api/messages": {
        target: `http://localhost:${WEBHOOK_PORT}`,
        changeOrigin: true,
      },
      "/webhook": {
        target: `http://localhost:${WEBHOOK_PORT}`,
        changeOrigin: true,
      },
    },
  },
})));
