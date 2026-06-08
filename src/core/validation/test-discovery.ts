import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { isPathConfined } from '../../lib/path-confinement.js';

export function isTestPatternSafe(pattern: string): boolean {
  if (!pattern || pattern.includes('..')) return false;
  if (pattern.includes('/') || pattern.includes('\\')) return false;
  return true;
}

function isCandidateConfined(candidate: string, projectDir: string): boolean {
  const rel = relative(projectDir, candidate);
  return isPathConfined(rel, projectDir);
}

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
  if (testPattern && !isTestPatternSafe(testPattern)) return null;

  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.\w+$/, '');

  const candidates = testPattern
    ? buildCandidatesFromPattern(name, dir, projectDir, testPattern)
    : buildDefaultTsCandidates(name, dir, projectDir);

  for (const candidate of candidates) {
    if (!isCandidateConfined(candidate, projectDir)) continue;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
