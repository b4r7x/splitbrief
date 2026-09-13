import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOnPath } from './on-path.js';
import type { Stack } from './types.js';

export const goStack: Stack = {
  id: 'go',
  language: 'go',
  markers: ['go.mod'],
  typecheck: () => 'go vet ./...',
  lint: (projectDir) => {
    const hasConfig = ['.golangci.yml', '.golangci.yaml'].some((file) =>
      existsSync(join(projectDir, file)),
    );
    if (hasConfig) return 'golangci-lint run';
    if (isOnPath('staticcheck')) return 'staticcheck ./...';
    return null;
  },
  test: () => 'go test ./...',
  testFilePatterns: ['*_test.go'],
  testDirs: [],
  narrowing: { kind: 'package-arg' },
  allowedCommands: ['go', 'golangci-lint', 'staticcheck'],
};
