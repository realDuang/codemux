import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

import { resolve } from 'path';
import { createLogger } from 'vite';
import { createAuthProxyPlugin, isElectronRemoteRequestAllowed, preserveProxyRequestIdentity } from './scripts/auth-proxy-plugin';
import { GATEWAY_PORT, WEBHOOK_PORT, WEB_PORT } from './shared/ports';

// Custom logger that suppresses proxy errors during startup
const logger = createLogger();
const _loggerError = logger.error.bind(logger);
logger.error = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('proxy error:')) return;
  _loggerError(msg, options);
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['ws', 'shell-env', 'electron-log'] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/main/index.ts'),
      },
      rollupOptions: {
        external: ['electron', 'bufferutil', 'utf-8-validate', 'node-pty'],
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
        },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts'),
      },
      rollupOptions: {
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },

  renderer: {
    root: '.',
    base: './',
    customLogger: logger,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
        output: {
          manualChunks: {
            shiki: ['shiki', '@shikijs/core', '@shikijs/transformers'],
          },
        },
      },
    },
    plugins: [
      tailwindcss(),
      solid(),
      // Proxy auth/device API requests to Electron's internal Auth API server
      createAuthProxyPlugin({
        defaultPort: WEB_PORT,
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      hmr: false,
      host: true,
      port: WEB_PORT,
      // The host's tunnel targets this configured port; never silently move it.
      strictPort: true,
      allowedHosts: true,
      proxy: {
        // Proxy Gateway WebSocket to the Gateway server
        '/ws': {
          target: `http://localhost:${GATEWAY_PORT}`,
          ws: true,
          // Vite awaits this hook before handing upgrades to its WS proxy.
          bypass: async req => await isElectronRemoteRequestAllowed(req, true) ? undefined : false,
          configure: proxy => {
            proxy.on('proxyReq', preserveProxyRequestIdentity);
            proxy.on('proxyReqWs', preserveProxyRequestIdentity);
          },
        },
        // Proxy webhook endpoints to the WebhookServer
        '/api/messages': {
          target: `http://localhost:${WEBHOOK_PORT}`,
          changeOrigin: true,
        },
        '/webhook': {
          target: `http://localhost:${WEBHOOK_PORT}`,
          changeOrigin: true,
        },
      },
    },
  },
});
