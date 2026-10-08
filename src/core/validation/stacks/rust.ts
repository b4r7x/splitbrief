import type { Stack } from './types.js';

export const rustStack: Stack = {
  id: 'rust',
  language: 'rust',
  markers: ['Cargo.toml'],
  test: () => 'cargo test',
  testFilePatterns: [],
  testDirs: [],
  inlineTests: /#\[cfg\(test\)\]/,
  narrowing: { kind: 'name-filter', flag: '--' },
  allowedCommands: ['cargo'],
};
