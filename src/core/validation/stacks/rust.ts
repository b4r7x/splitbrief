import type { Stack } from './types.js';

export const rustStack: Stack = {
  id: 'rust',
  language: 'rust',
  markers: ['Cargo.toml'],
  typecheck: () => 'cargo check',
  lint: () => 'cargo clippy --no-deps',
  test: () => 'cargo test',
  testFilePatterns: [],
  testDirs: [],
  inlineTests: /#\[cfg\(test\)\]/,
  narrowing: { kind: 'name-filter', flag: '--' },
  allowedCommands: ['cargo'],
  missingSubcommand: { exitCode: 101, stderr: /no such command/i },
};
