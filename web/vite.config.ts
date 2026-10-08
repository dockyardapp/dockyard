import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The panel is served by the Fastify API in production from web/dist.
// In dev, Vite serves on 5190 and proxies /api + /ws to the API on 8190.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8190', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8190', ws: true },
    },
  },
});
