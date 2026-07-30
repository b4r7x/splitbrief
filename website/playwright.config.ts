import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error('PLAYWRIGHT_PORT must be an integer from 1 through 65535');
}

const baseURL = `http://127.0.0.1:${PORT}`;
const MOBILE_TESTS = ['**/matrix-mobile.e2e.ts', '**/docs-mobile.e2e.ts'];
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === 'true';

export default defineConfig({
  testDir: './testing/e2e',
  testMatch: '**/*.e2e.ts',
  snapshotPathTemplate:
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
  },
  fullyParallel: true,
  failOnFlakyTests: Boolean(process.env.CI),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    colorScheme: 'dark',
    contextOptions: {
      reducedMotion: 'reduce',
    },
    trace: 'retain-on-failure',
  },
  projects: [
    // Browser portability is not claimed; add engines together with matching CI provisioning.
    {
      name: 'chromium',
      testIgnore: MOBILE_TESTS,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: MOBILE_TESTS,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run serve:test',
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
    },
    reuseExistingServer,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 120_000,
    url: baseURL,
  },
});
