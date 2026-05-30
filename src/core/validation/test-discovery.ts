import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function buildDefaultTsCandidates(name: string, dir: string, projectDir: string): string[] {
  return [
    join(projectDir, dir, `${name}.test.ts`),
    join(projectDir, dir, `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.ts`),
    join(projectDir, dir.replace(/^src/, 'tests'), `${name}.test.tsx`),
    join(projectDir, dir.replace(/^src/, 'test'), `${name}.test.tsx`),
  ];
}

function buildCandidatesFromPattern(
  name: string,
  dir: string,
  projectDir: string,
  testPattern: string,
): string[] {
  const resolved = testPattern.replace('*', name);
  return [
    join(projectDir, dir, resolved),
    join(projectDir, dir.replace(/^src/, 'tests'), resolved),
    join(projectDir, dir.replace(/^src/, 'test'), resolved),
  ];
}

export function findAffectedTestFile(
  taskFile: string,
  projectDir: string,
  testPattern?: string,
): string | null {
  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.\w+$/, '');

  const candidates = testPattern
    ? buildCandidatesFromPattern(name, dir, projectDir, testPattern)
    : buildDefaultTsCandidates(name, dir, projectDir);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
