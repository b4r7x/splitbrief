import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { isOnPath } from './on-path.js';

describe('isOnPath', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = createTempDir('on-path');
    writeFileSync(join(tmpDir, 'staticcheck'), '');
    chmodSync(join(tmpDir, 'staticcheck'), 0o755);
  });
  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('finds an executable in a temp PATH entry and misses an absent one', () => {
    const env = { PATH: [tmpDir, '/nonexistent-dir'].join(delimiter) };
    expect(isOnPath('staticcheck', env)).toBe(true);
    expect(isOnPath('golangci-lint', env)).toBe(false);
  });

  it('returns false when PATH is unset or empty', () => {
    expect(isOnPath('staticcheck', {})).toBe(false);
    expect(isOnPath('staticcheck', { PATH: '' })).toBe(false);
  });
});
