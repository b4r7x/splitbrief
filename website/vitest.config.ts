import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    setupFiles: [
      fileURLToPath(new URL('../testing/helpers/scrub-credentials.ts', import.meta.url)),
    ],
    environment: 'node',
  },
});
