import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { isPathConfined } from '../../../lib/path-confinement.js';
import { isTestPatternSafe } from '../test-discovery.js';
import { goStack } from './go.js';
import { javascriptStack } from './javascript.js';
import { pythonStack } from './python.js';
import { rustStack } from './rust.js';
import type { Stack, StackId, StackMarker, TestNarrowing } from './types.js';
import { typescriptStack } from './typescript.js';

export const STACKS: readonly Stack[] = [
  rustStack,
  goStack,
  pythonStack,
  typescriptStack,
  javascriptStack,
];

function markerMatches(marker: StackMarker, projectDir: string): boolean {
  return typeof marker === 'string' ? existsSync(join(projectDir, marker)) : marker(projectDir);
}

export function detectStack(projectDir: string, pin?: StackId): Stack | null {
  if (pin !== undefined) return STACKS.find((stack) => stack.id === pin) ?? null;
  return (
    STACKS.find((stack) => stack.markers.some((marker) => markerMatches(marker, projectDir))) ??
    null
  );
}

function patternParts(pattern: string): { dir: string; prefix: string; suffix: string } {
  const slash = pattern.lastIndexOf('/');
  const dir = slash === -1 ? '' : pattern.slice(0, slash);
  const file = pattern.slice(slash + 1);
  const star = file.indexOf('*');
  return star === -1
    ? { dir, prefix: file, suffix: '' }
    : { dir, prefix: file.slice(0, star), suffix: file.slice(star + 1) };
}

function matchesPattern(path: string, pattern: string): boolean {
  const { dir, prefix, suffix } = patternParts(pattern);
  if (dir !== '' && basename(dirname(path)) !== dir) return false;
  const base = basename(path);
  if (!pattern.includes('*')) return base === prefix;
  return (
    base.length > prefix.length + suffix.length && base.startsWith(prefix) && base.endsWith(suffix)
  );
}

/** A file by a stack's test file pattern, or any file under one of its test folders. */
export function isTestScript(file: string, stacks: readonly Stack[] = STACKS): boolean {
  const dirs = file.split('/').slice(0, -1);
  return stacks.some(
    (stack) =>
      stack.testFilePatterns.some((pattern) => matchesPattern(file, pattern)) ||
      stack.testDirs.some((dir) => dirs.includes(dir)),
  );
}

const TEST_FILE_STEM = /^(?:tests?|spec)$/;

function hasInlineTests(absolutePath: string, pattern: RegExp): boolean {
  if (!existsSync(absolutePath)) return false;
  return pattern.test(readFileSync(absolutePath, 'utf-8'));
}

export function findAffectedTestFiles(
  taskFile: string,
  projectDir: string,
  stack: Stack,
  testPattern?: string,
): string[] {
  if (testPattern !== undefined && !isTestPatternSafe(testPattern)) return [];
  const patterns = testPattern !== undefined ? [testPattern] : stack.testFilePatterns;
  const found: string[] = [];
  const add = (candidate: string) => {
    if (!isPathConfined(relative(projectDir, candidate), projectDir)) return;
    if (!existsSync(candidate)) return;
    if (!found.includes(candidate)) found.push(candidate);
  };

  const self = join(projectDir, taskFile);
  if (patterns.some((pattern) => matchesPattern(taskFile, pattern))) add(self);
  if (stack.inlineTests !== undefined && hasInlineTests(self, stack.inlineTests)) add(self);

  const dir = dirname(taskFile);
  const name = basename(taskFile).replace(/\.\w+$/, '');
  for (const pattern of patterns) {
    const { dir: patternDir, prefix, suffix } = patternParts(pattern);
    const fileName = `${prefix}${name}${suffix}`;
    add(join(projectDir, dir, patternDir, fileName));
    for (const testDir of stack.testDirs) {
      add(join(projectDir, dir.replace(/^src/, testDir), patternDir, fileName));
    }
  }
  // A runner that takes file paths runs a named test file no pattern maps, such as a root
  // `test.js`. A name filter or a package argument would select other tests, so those still skip.
  if (
    found.length === 0 &&
    stack.narrowing.kind === 'path-arg' &&
    (isTestScript(taskFile, [stack]) || TEST_FILE_STEM.test(name))
  ) {
    add(self);
  }
  return found;
}

export function buildTestArgs(
  resolved: { cmd: string; args: readonly string[] },
  targets: readonly string[],
  narrowing: TestNarrowing,
): string[] {
  const args = [...resolved.args];
  if (targets.length === 0) return args;
  switch (narrowing.kind) {
    case 'path-arg':
      return narrowing.separator === '--' ? [...args, '--', ...targets] : [...args, ...targets];
    case 'package-arg': {
      const dirs = [...new Set(targets.map((target) => dirname(target)))];
      return [...args.filter((arg) => arg !== './...'), ...dirs.map((dir) => `./${dir}/`)];
    }
    case 'name-filter': {
      const names = [...new Set(targets.map((target) => basename(target).replace(/\.\w+$/, '')))];
      return narrowing.flag === '-run'
        ? [...args, '-run', names.join('|')]
        : [...args, '--', ...names];
    }
    case 'none':
      return args;
  }
}
