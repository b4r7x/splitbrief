import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function createTestFileFinder() {
  const cache = new Map<string, string | null>();

  return function findAffectedTestFile(taskFile: string, projectDir: string): string | null {
    const cacheKey = `${projectDir}::${taskFile}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const dir = dirname(taskFile);
    const name = basename(taskFile).replace(/\.(ts|tsx|js|jsx)$/, '');

    const candidates = [
      join(projectDir, dir, `${name}.test.ts`),
      join(projectDir, dir, `${name}.test.tsx`),
      join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.ts`),
      join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.ts`),
      join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.tsx`),
      join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.tsx`),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        cache.set(cacheKey, candidate);
        return candidate;
      }
    }

    cache.set(cacheKey, null);
    return null;
  };
}
