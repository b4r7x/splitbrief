import { hasTestScript, PACKAGE_TEST_COMMAND } from './typescript.js';
import type { Stack } from './types.js';

export const javascriptStack: Stack = {
  id: 'javascript',
  language: 'javascript',
  markers: ['package.json'],
  test: (projectDir) => (hasTestScript(projectDir) ? PACKAGE_TEST_COMMAND : null),
  testFilePatterns: ['*.test.js', '*.spec.js', '*.test.mjs'],
  testDirs: ['tests', 'test', '__tests__'],
  narrowing: { kind: 'path-arg', separator: '--' },
  allowedCommands: ['npm', 'npx', 'node', 'vitest', 'jest', 'eslint', 'prettier', 'biome'],
};
