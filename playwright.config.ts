// Default import: the named `loadEnvConfig` import fails in this "type": "module" repo.
import nextEnv from '@next/env';
import { defineConfig, devices } from '@playwright/test';

// 07 §11 (D-44). Playwright on the host drives the compose PRODUCTION image, so the stack must
// already be up: `docker compose up --build --wait`, then `pnpm test:e2e`. There is no webServer.
// The host-side values (SEED_DEMO_PASSWORD for TC-E00, RECEIPT_STORAGE_DRIVER for TC-E06,
// E2E_BASE_URL) come from the same .env compose interpolates; @next/env strips its inline
// comments, and a variable already set in the shell wins.
nextEnv.loadEnvConfig(import.meta.dirname);

export default defineConfig({
  testDir: 'e2e',
  // Journeys share the seeded queues (ravi, meera): one worker, files in order, unique titles.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // localhost, not 127.0.0.1: the CSRF Origin check compares against APP_BASE_URL.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    // A browser far from IST: every instant on screen must still read IST (05 §13).
    timezoneId: 'America/Los_Angeles',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // TC-E00: one storageState per persona, made through the login API (e2e/.auth, gitignored).
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});
