import { isRecord } from '../../../utils/type-guards.js';
import { packageScript, readPackageJson } from '../../project-meta.js';
import type { ValidationStage } from '../../schemas/enums.js';
import { detectLintCommand } from '../lint-detection.js';
import type { Stack } from './types.js';

export function hasTestScript(projectDir: string): boolean {
  return packageScript(projectDir, 'test') !== null;
}

// npm's own shorthand: `test` is a lifecycle script, every other stage needs `run`.
export function packageScriptCommand(stage: ValidationStage): string {
  return stage === 'test' ? 'npm test' : `npm run ${stage}`;
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
  typecheck: () => 'npx tsc --noEmit',
  lint: detectLintCommand,
  test: (projectDir) => (hasTestScript(projectDir) ? packageScriptCommand('test') : null),
  testFilePatterns: ['*.test.ts', '*.test.tsx', '*.spec.ts', '__tests__/*.ts'],
  testDirs: ['tests', 'test', '__tests__'],
  narrowing: { kind: 'path-arg', separator: '--' },
  allowedCommands: ['npm', 'npx', 'node', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'biome'],
};
