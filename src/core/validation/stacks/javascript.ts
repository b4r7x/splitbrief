import { detectLintCommand } from '../lint-detection.js';
import { hasTestScript, packageScriptCommand } from './typescript.js';
import type { Stack } from './types.js';

export const javascriptStack: Stack = {
  id: 'javascript',
  language: 'javascript',
  markers: ['package.json'],
  typecheck: () => null,
  lint: detectLintCommand,
  test: (projectDir) => (hasTestScript(projectDir) ? packageScriptCommand('test') : null),
  testFilePatterns: ['*.test.js', '*.spec.js', '*.test.mjs'],
  testDirs: ['tests', 'test', '__tests__'],
  narrowing: { kind: 'path-arg', separator: '--' },
  allowedCommands: ['npm', 'npx', 'node', 'vitest', 'jest', 'eslint', 'prettier', 'biome'],
};
