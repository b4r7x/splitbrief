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

// A task whose file already is a test file is tested by that file itself;
// deriving a candidate from it would look for `foo.test.test.ts` and find
// nothing, leaving the task green with its test never run.
function isSelfTestFile(base: string, testPattern: string | undefined): boolean {
  if (testPattern === undefined) return /\.test\.tsx?$/.test(base);
  const star = testPattern.indexOf('*');
  if (star === -1) return base === testPattern;
  const prefix = testPattern.slice(0, star);
  const suffix = testPattern.slice(star + 1);
  return (
    base.length > prefix.length + suffix.length && base.startsWith(prefix) && base.endsWith(suffix)
  );
}

export function findAffectedTestFile(
  taskFile: string,
  projectDir: string,
  testPattern?: string,
): string | null {
  if (testPattern && !isTestPatternSafe(testPattern)) return null;

  const dir = dirname(taskFile);
  const base = basename(taskFile);

  if (isSelfTestFile(base, testPattern)) {
    const self = join(projectDir, dir, base);
    if (isCandidateConfined(self, projectDir) && existsSync(self)) return self;
  }

  const name = base.replace(/\.\w+$/, '');

  const candidates = testPattern
    ? buildCandidatesFromPattern(name, dir, projectDir, testPattern)
    : buildDefaultTsCandidates(name, dir, projectDir);

  for (const candidate of candidates) {
    if (!isCandidateConfined(candidate, projectDir)) continue;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
