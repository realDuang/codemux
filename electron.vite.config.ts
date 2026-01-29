import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { createAuthProxyPlugin } from './scripts/auth-proxy-plugin';
import { tunnelManager } from './scripts/tunnel-manager';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/main/index.ts'),
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
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    plugins: [
      tailwindcss(),
      solid(),
      // Proxy auth/device API requests to Electron's internal Auth API server
      createAuthProxyPlugin({
        tunnelManager,
        defaultPort: 5173,
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      host: true,
      port: 5173,
      allowedHosts: [
        "localhost",
        ".trycloudflare.com",
      ],
      proxy: {
        // Proxy OpenCode API requests to the OpenCode server
        '/opencode-api': {
          target: 'http://localhost:4096',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/opencode-api/, ''),
          // Handle SSE connections properly
          ws: false,
        },
      },
    },
  },
});