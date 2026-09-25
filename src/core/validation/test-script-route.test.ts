import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ResolvedCommand } from './stage-command.js';
import { routeTestScript } from './test-script-route.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const NPM_TEST: ResolvedCommand = { cmd: 'npm', args: ['test'], source: 'manifest' };

describe('routeTestScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('test-script-route');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          'test:watch': 'vitest',
          'test:e2e': 'npx vitest run --config=e2e/vitest.e2e.config.ts',
        },
      }),
    );
    mkdirSync(join(tempDir, 'e2e'), { recursive: true });
    writeFileSync(
      join(tempDir, 'e2e', 'vitest.e2e.config.ts'),
      "export default { test: { include: ['e2e/**/*.test.ts'], exclude: ['e2e/live/**'] } };",
    );
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('routes targets every one of which a test script config includes to that script', () => {
    expect(
      routeTestScript({
        projectDir: tempDir,
        resolved: NPM_TEST,
        targets: ['e2e/a.test.ts', 'e2e/b/c.test.ts'],
      }),
    ).toEqual({
      cmd: 'npm',
      args: ['run', 'test:e2e'],
      source: 'manifest',
    });
  });

  it('keeps npm test when a target falls outside the include or inside the exclude', () => {
    expect(
      routeTestScript({ projectDir: tempDir, resolved: NPM_TEST, targets: ['src/a.test.ts'] }),
    ).toBeNull();
    expect(
      routeTestScript({ projectDir: tempDir, resolved: NPM_TEST, targets: ['e2e/live/a.test.ts'] }),
    ).toBeNull();
    expect(
      routeTestScript({
        projectDir: tempDir,
        resolved: NPM_TEST,
        targets: ['e2e/a.test.ts', 'src/a.test.ts'],
      }),
    ).toBeNull();
  });

  it('never reroutes a command other than npm test', () => {
    const custom: ResolvedCommand = { cmd: 'npm', args: ['run', 'unit'], source: 'manifest' };
    expect(
      routeTestScript({ projectDir: tempDir, resolved: custom, targets: ['e2e/a.test.ts'] }),
    ).toBeNull();
  });

  it("routes this repo's e2e scenarios to test:e2e and leaves e2e helpers and live on npm test", () => {
    expect(
      routeTestScript({
        projectDir: REPO_ROOT,
        resolved: NPM_TEST,
        targets: ['testing/e2e/scenarios/stop-continue.test.ts'],
      })?.args,
    ).toEqual(['run', 'test:e2e']);
    expect(
      routeTestScript({
        projectDir: REPO_ROOT,
        resolved: NPM_TEST,
        targets: ['testing/e2e/helpers/pty.test.ts'],
      }),
    ).toBeNull();
    expect(
      routeTestScript({
        projectDir: REPO_ROOT,
        resolved: NPM_TEST,
        targets: ['testing/e2e/scenarios/live/fixture-loop.test.ts'],
      }),
    ).toBeNull();
  });
});
