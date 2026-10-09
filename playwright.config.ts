import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the production build served by the Node entry
 * (node/server.ts) on a throwaway SQLite database, seeded with demo data
 * through the API (scripts/seed-demo.mjs), driven in the locally installed
 * Google Chrome. Run locally with `npm run test:e2e`; not part of CI.
 *
 * No Plaid, market-data or FX providers are configured, so nothing leaves
 * the machine and amounts are deterministic.
 */
const PORT = 8788;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.results',
  // Tests share one seeded database and change it, so run them in order.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['seed'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'rm -rf e2e/.data && mkdir -p e2e/.data && npm run build && tsx node/server.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL: 'file:e2e/.data/wattle.db',
      ALLOW_DEV_LOGIN: '1',
      DEV_LOGIN_EMAILS: 'demo@example.com,partner@example.com',
      // Test-only key (32 bytes, base64). Never used outside e2e runs.
      TOKEN_ENC_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      FX_PROVIDER: 'none',
    },
  },
});
