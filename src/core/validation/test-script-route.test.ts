import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

  describe('project selection', () => {
    beforeEach(() => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          scripts: {
            test: 'vitest run --project unit',
            'test:watch': 'vitest',
            'test:integration': 'vitest run --project integration',
          },
        }),
      );
      writeFileSync(
        join(tempDir, 'vitest.config.ts'),
        `export default { test: { projects: [
          { test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['**/*.integration.test.ts'] } },
          { test: { name: "integration", include: ['src/**/*.integration.test.ts'], exclude: ['src/private/**'] } },
        ] } };`,
      );
    });

    it('routes integration targets through their selected project', () => {
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.integration.test.ts'],
        })?.args,
      ).toEqual(['run', 'test:integration']);
    });

    it('keeps unit, mixed and excluded targets on npm test', () => {
      for (const targets of [
        ['src/a.test.ts'],
        ['src/a.test.ts', 'src/b.integration.test.ts'],
        ['src/private/a.integration.test.ts'],
      ]) {
        expect(routeTestScript({ projectDir: tempDir, resolved: NPM_TEST, targets })).toBeNull();
      }
    });

    it('keeps targets reached by npm test when another script uses the whole config', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          scripts: { test: 'vitest run --project unit', 'test:watch': 'vitest' },
        }),
      );
      expect(
        routeTestScript({ projectDir: tempDir, resolved: NPM_TEST, targets: ['src/a.test.ts'] }),
      ).toBeNull();
    });

    it('accepts the equals form of the project flag', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { 'test:integration': 'npx vitest run --project=integration' } }),
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.integration.test.ts'],
        })?.args,
      ).toEqual(['run', 'test:integration']);
    });

    it.each(['vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'])(
      'uses the default config %s when earlier config files are absent',
      (name) => {
        renameSync(join(tempDir, 'vitest.config.ts'), join(tempDir, name));
        expect(
          routeTestScript({
            projectDir: tempDir,
            resolved: NPM_TEST,
            targets: ['src/a.integration.test.ts'],
          })?.args,
        ).toEqual(['run', 'test:integration']);
      },
    );

    it('uses the first default config that exists', () => {
      writeFileSync(
        join(tempDir, 'vitest.config.mts'),
        "export default { test: { name: 'integration', include: ['other/**/*.test.ts'] } };",
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.integration.test.ts'],
        })?.args,
      ).toEqual(['run', 'test:integration']);
    });

    it.each([' ', '='])('selects a project from an explicit --config%s flag', (separator) => {
      writeFileSync(
        join(tempDir, 'e2e', 'named.config.ts'),
        "export default { test: { name: 'integration', include: ['other/**/*.integration.test.ts'] } };",
      );
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          scripts: {
            test: 'vitest run --project unit',
            'test:integration': `vitest run --config${separator}e2e/named.config.ts --project integration`,
          },
        }),
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['other/a.integration.test.ts'],
        })?.args,
      ).toEqual(['run', 'test:integration']);
    });

    it('balances glob braces before and after the selected project name', () => {
      writeFileSync(
        join(tempDir, 'vitest.config.ts'),
        `export default { test: { projects: [
          { test: { include: ['other/**/*.test.{ts,tsx}'], name: 'other', exclude: [] } },
          { test: { include: ['src/**/*.integration.test.{ts,tsx}'], name: 'integration', exclude: ['src/{private,secret}/**'] } },
          { test: { name: 'unit', include: ['src/**/*.test.{ts,tsx}'], exclude: ['**/*.integration.test.{ts,tsx}'] } },
        ] } };`,
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.integration.test.ts', 'src/b.integration.test.tsx'],
        })?.args,
      ).toEqual(['run', 'test:integration']);
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/private/a.integration.test.ts'],
        }),
      ).toBeNull();
    });

    it('reaches each target through any selected project and ignores unknown names', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          scripts: {
            'test:all': 'vitest run --project missing --project unit --project=integration',
          },
        }),
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.test.ts', 'src/b.integration.test.ts'],
        })?.args,
      ).toEqual(['run', 'test:all']);
    });

    it('does not use another project when a selected name is absent', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ scripts: { 'test:missing': 'vitest run --project missing' } }),
      );
      expect(
        routeTestScript({
          projectDir: tempDir,
          resolved: NPM_TEST,
          targets: ['src/a.integration.test.ts'],
        }),
      ).toBeNull();
    });
  });

  it("routes this repo's integration targets and keeps unit targets on npm test", () => {
    for (const target of [
      'src/engine/orchestrator/apply/run.integration.test.ts',
      'testing/integration/cli/exit-codes.test.ts',
    ]) {
      expect(
        routeTestScript({ projectDir: REPO_ROOT, resolved: NPM_TEST, targets: [target] })?.args,
      ).toEqual(['run', 'test:integration']);
    }
    expect(
      routeTestScript({
        projectDir: REPO_ROOT,
        resolved: NPM_TEST,
        targets: ['src/core/validation/test-script-route.test.ts'],
      }),
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
