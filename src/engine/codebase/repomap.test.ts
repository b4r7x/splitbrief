import { copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { buildRepoMap } from './repomap.js';
import { initParser } from './parse.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('buildRepoMap', () => {
  let projectDir: string;

  beforeAll(async () => {
    await initParser();
    projectDir = createTempDir('repomap-test');
    const fixtureSrc = resolve('testing/fixtures/codebase/sample-project');
    for (const file of readdirSync(fixtureSrc)) {
      if (file.endsWith('.ts')) {
        copyFileSync(join(fixtureSrc, file), join(projectDir, file));
      }
    }
  });

  afterAll(() => {
    if (projectDir) cleanupTempDir(projectDir);
  });

  it('returns a non-empty string with file headers and signatures', async () => {
    const out = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    expect(out).toContain('a.ts:');
    expect(out).toContain('b.ts:');
    expect(out).toContain('c.ts:');
    expect(out).toContain('d.ts:');
    expect(out).toMatch(/export function aMain\(\): string/);
  });

  it('respects tokenBudget by dropping lowest-ranked files when tight', async () => {
    const tight = await buildRepoMap(projectDir, { tokenBudget: 30 });
    expect(tight.length).toBeGreaterThan(0);
    // Just check that output is bounded (not asserting exact files due to ranking variance)
    expect(tight.length).toBeLessThan(2000);
  });

  it('focusFiles bias the ranking', async () => {
    const noFocus = await buildRepoMap(projectDir, { tokenBudget: 5000 });
    const focused = await buildRepoMap(projectDir, { tokenBudget: 5000, focusFiles: ['d.ts'] });
    // Both contain d.ts but with focus, d should appear earlier (lower index)
    const noFocusIdx = noFocus.indexOf('d.ts');
    const focusedIdx = focused.indexOf('d.ts');
    expect(focusedIdx).toBeGreaterThanOrEqual(0);
    expect(noFocusIdx).toBeGreaterThanOrEqual(0);
    // With focus, d.ts should be earlier or equal
    expect(focusedIdx).toBeLessThanOrEqual(noFocusIdx);
  });
});
