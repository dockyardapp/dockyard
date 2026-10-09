import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const PORT = Number(process.env.DOCKYARD_E2E_PORT ?? 8000);
const BASE_URL = process.env.DOCKYARD_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Chromium is already on this host (the browser tool's copy), so the suite
 * points at it instead of downloading a second one. Override CHROME_PATH on a
 * machine where it lives somewhere else.
 */
const CHROME_PATH =
  process.env.CHROME_PATH ?? '/root/.agent-browser/browsers/chrome-155.0.8059.39/chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    launchOptions: {
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Brings the API up if it is not already listening, so the suite is
  // re-runnable on a clean checkout. The server serves web/dist, so `npm run
  // build` in web/ must have run first.
  webServer: {
    command: 'node server/src/index.ts',
    cwd: repoRoot,
    url: `${BASE_URL}/api/system/health`,
    reuseExistingServer: true,
    timeout: 90_000,
    // Spread process.env: the server needs PATH to resolve `node` and its own
    // .env for DATABASE_URL.
    env: {
      ...(process.env as Record<string, string>),
      PORT: String(PORT),
      // This suite signs in many throwaway accounts from one IP, which trips the
      // login limiter (10/min by default, and that default is the right one for
      // production). Raise it here rather than weakening the shipped value.
      DOCKYARD_LOGIN_RATE_MAX: '500',
      // The template repository is a network dependency and this suite must not have any. Off here,
      // so the catalog is whatever the spec seeds into data/templates before the run. The repository
      // source has its own tests, against a local server standing in for GitHub.
      DOCKYARD_TEMPLATES_REPO: '',
    },
  },
});
