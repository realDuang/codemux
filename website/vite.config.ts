import { defineConfig } from 'vite';

export default defineConfig({
  base: '/codemux/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 4000,
  },
});
