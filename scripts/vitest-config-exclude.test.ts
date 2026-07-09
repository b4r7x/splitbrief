import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function coverageExcludes(): string[] {
  const coverage = config.test?.coverage;
  const exclude = coverage && 'exclude' in coverage ? coverage.exclude : undefined;
  return Array.isArray(exclude) ? exclude : [];
}

describe('vitest coverage exclude list', () => {
  it('references only paths that exist on disk (no glob-free stale entries)', () => {
    const concrete = coverageExcludes().filter((entry) => !entry.includes('*'));
    const missing = concrete.filter((entry) => !existsSync(new URL(entry, `file://${repoRoot}`)));
    expect(missing).toEqual([]);
  });
});
