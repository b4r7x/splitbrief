import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { goStack } from './go.js';

describe('goStack', () => {
  let dir: string;
  let binDir: string;
  let originalPath: string | undefined;
  beforeEach(() => {
    dir = createTempDir('stack-go');
    binDir = createTempDir('stack-go-bin');
    originalPath = process.env['PATH'];
    process.env['PATH'] = binDir;
  });
  afterEach(() => {
    process.env['PATH'] = originalPath;
    cleanupTempDir(dir);
    cleanupTempDir(binDir);
  });

  it('go: .golangci.yml selects golangci-lint run', () => {
    writeFileSync(join(dir, '.golangci.yml'), '');
    expect(goStack.lint(dir)).toBe('golangci-lint run');
  });

  it('go: .golangci.yaml selects golangci-lint run', () => {
    writeFileSync(join(dir, '.golangci.yaml'), '');
    expect(goStack.lint(dir)).toBe('golangci-lint run');
  });

  it('go: staticcheck on PATH is the fallback lint', () => {
    expect(goStack.lint(dir)).toBeNull();
    const bin = join(binDir, 'staticcheck');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(goStack.lint(dir)).toBe('staticcheck ./...');
  });

  it('declares go.mod, vet, test and package-arg narrowing', () => {
    expect(goStack.markers).toEqual(['go.mod']);
    expect(goStack.typecheck(dir)).toBe('go vet ./...');
    expect(goStack.test(dir)).toBe('go test ./...');
    expect(goStack.testFilePatterns).toEqual(['*_test.go']);
    expect(goStack.narrowing).toEqual({ kind: 'package-arg' });
  });
});
