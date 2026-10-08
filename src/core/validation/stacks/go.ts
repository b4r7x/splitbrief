import type { Stack } from './types.js';

export const goStack: Stack = {
  id: 'go',
  language: 'go',
  markers: ['go.mod'],
  test: () => 'go test ./...',
  testFilePatterns: ['*_test.go'],
  testDirs: [],
  narrowing: { kind: 'package-arg' },
  allowedCommands: ['go', 'golangci-lint', 'staticcheck'],
};
