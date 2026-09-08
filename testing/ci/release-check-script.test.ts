import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import e2eConfig from '../e2e/vitest.e2e.config.js';
import liveConfig from '../e2e/vitest.live.config.js';

const REPO_ROOT = join(import.meta.dirname, '../..');

const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const RELEASE_CHECK =
  'npm run format:check && npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run check:invariants && npm run skills:check';
const E2E_CONFIG = 'testing/e2e/vitest.e2e.config.ts';
const LIVE_CONFIG = 'testing/e2e/vitest.live.config.ts';
const REAL_CLI_MARKERS = ['SPLITBRIEF_REAL_CLI', 'live-harness'];

const liveScripts = Object.entries(scripts).filter(([key]) => key.startsWith('test:e2e:live'));

function collect(config: ViteUserConfig): string[] {
  const { include = [], exclude = [] } = config.test ?? {};
  return globSync(include, { cwd: REPO_ROOT, exclude }).sort();
}

function reachesRealCli(file: string): boolean {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  return REAL_CLI_MARKERS.some((marker) => source.includes(marker));
}

describe('release-check and live-tier npm scripts', () => {
  it('runs the fast gate without coverage instrumentation', () => {
    expect(scripts['release-check']).toBe(RELEASE_CHECK);
    expect(scripts['release-check']).not.toContain('coverage');
  });

  it('keeps test-ci as the exhaustive form that still runs coverage', () => {
    expect(scripts['test-ci']).toContain('npm run test:coverage');
    expect(scripts['test-ci']).not.toBe(scripts['release-check']);
  });

  it('gates every live tier behind the opt-in env switch and its own config', () => {
    expect(liveScripts.length).toBeGreaterThan(0);
    for (const [key, command] of liveScripts) {
      expect(command, key).toMatch(/^SPLITBRIEF_REAL_CLI_E2E=1 /);
      expect(command, key).toContain(`--config ${LIVE_CONFIG}`);
    }
    expect(scripts['test:e2e:live']).not.toContain('SPLITBRIEF_REAL_CLI_TIER=heavy');
    expect(scripts['test:e2e:live:heavy']).toContain('SPLITBRIEF_REAL_CLI_TIER=heavy');
  });

  it('leaves the live tier named by no other script', () => {
    const liveKeys = liveScripts.map(([key]) => key);
    for (const [key, command] of Object.entries(scripts)) {
      if (liveKeys.includes(key)) continue;
      expect(command, key).not.toContain('test:e2e:live');
      expect(command, key).not.toContain('SPLITBRIEF_REAL_CLI');
    }
  });
});

describe('live-tier reachability through the e2e configs', () => {
  it('keeps every real-CLI scenario out of the free e2e run', () => {
    expect(scripts['test:e2e']).toContain(`--config ${E2E_CONFIG}`);

    const collected = collect(e2eConfig);

    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter(reachesRealCli)).toEqual([]);
  });

  it('leaves the live config the only collector that reaches them', () => {
    const realCli = globSync('testing/e2e/scenarios/**/*.test.ts', { cwd: REPO_ROOT })
      .filter(reachesRealCli)
      .sort();

    expect(realCli.length).toBeGreaterThan(0);
    expect(collect(liveConfig)).toEqual(realCli);
  });
});
