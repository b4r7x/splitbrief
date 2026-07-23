import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCurrentFileContent, writeCurrentFileContent } from './contents.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
const itUnix = process.platform === 'win32' ? it.skip : it;

describe('confined project file reads', () => {
  itUnix('rejects reading dirty files through final symlinks', async () => {
    const dir = createTempDir('snapshot-symlink-read');
    const outside = createTempDir('snapshot-symlink-outside');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'src', 'leak.ts'));

      await expect(readCurrentFileContent(dir, 'src/leak.ts')).rejects.toThrow(/unsafe path/);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('writeCurrentFileContent rejects writing through final symlinks', async () => {
    const dir = createTempDir('snapshot-symlink-write');
    const outside = createTempDir('snapshot-symlink-write-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'target.txt'), 'outside');
      symlinkSync(join(outside, 'target.txt'), join(dir, 'src', 'linked.ts'));

      await expect(writeCurrentFileContent(dir, 'src/linked.ts', 'new')).rejects.toThrow(
        /unsafe path/,
      );
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});
