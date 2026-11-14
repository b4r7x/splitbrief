import { afterEach, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { collectCustomRunnerConsentChecks } from './consent-preflight.js';

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) cleanupTempDir(dir);
});

function tempDir(): string {
  const dir = createTempDir('consent-preflight');
  directories.push(dir);
  return dir;
}

it('publishes the seat rather than the trust tier as each consent check role', async () => {
  const checks = await collectCustomRunnerConsentChecks({
    config: makeConfig({
      planner: { kind: 'shell', command: 'cat', outputFormat: 'text' },
      reviewer: { kind: 'shell', command: 'cat', outputFormat: 'text' },
    }),
    projectDir: tempDir(),
    interaction: 'headless',
    stateDir: tempDir(),
  });

  expect(checks.map((check) => [check.id, check.metadata?.role])).toEqual([
    ['runners.consent.planner', 'planner'],
    ['runners.consent.reviewer', 'reviewer'],
  ]);
});
