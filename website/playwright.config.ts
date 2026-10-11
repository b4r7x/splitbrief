import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4173);
// One build directory per port, so parallel runs never empty each other's build.
const outDir = `dist/e2e-${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  use: {
    channel: 'chrome',
    baseURL: `http://localhost:${port}`,
  },
  projects: [{ name: 'chromium-desktop', use: { viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run build -- --outDir ${outDir} && npm run preview -- --outDir ${outDir}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
