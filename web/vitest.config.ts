import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Test config is separate from vite.config.ts so the production build stays
// untouched. jsdom because the console is a browser app; the pure logic
// (format, rbac, ws, the API client) is tested without rendering anything.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/api/types.ts'],
    },
  },
});
