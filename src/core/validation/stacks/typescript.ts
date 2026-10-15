import { isRecord } from '../../../utils/type-guards.js';
import { packageScript, readPackageJson } from '../../project-meta.js';
import type { Stack } from './types.js';

export function hasTestScript(projectDir: string): boolean {
  return packageScript(projectDir, 'test') !== null;
}

// npm's own shorthand: `test` is a lifecycle script and needs no `run`.
export const PACKAGE_TEST_COMMAND = 'npm test';

/**
 * Whether the `package.json` test script chains commands (`node --test test/unit && node --test
 * test/e2e`): `npm test -- <file>` hands the file to its last command only.
 */
export function chainsTestScript(projectDir: string): boolean {
  return /[;&|\n]/.test(packageScript(projectDir, 'test') ?? '');
}

export function hasTypescriptDependency(projectDir: string): boolean {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return false;
  const deps = pkg['dependencies'];
  const devDeps = pkg['devDependencies'];
  return (isRecord(deps) && 'typescript' in deps) || (isRecord(devDeps) && 'typescript' in devDeps);
}

export const typescriptStack: Stack = {
  id: 'typescript',
  language: 'typescript',
  markers: ['tsconfig.json', hasTypescriptDependency],
  test: (projectDir) => (hasTestScript(projectDir) ? PACKAGE_TEST_COMMAND : null),
  testFilePatterns: ['*.test.ts', '*.test.tsx', '*.spec.ts', '__tests__/*.ts'],
  testDirs: ['tests', 'test', '__tests__'],
  narrowing: { kind: 'path-arg', separator: '--' },
  allowedCommands: ['npm', 'npx', 'node', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'biome'],
};
