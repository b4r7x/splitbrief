import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  use: {
    channel: 'chrome',
    baseURL: `http://localhost:${port}`,
  },
  projects: [{ name: 'chromium-desktop', use: { viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
