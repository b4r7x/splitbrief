import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureChangedFilesBaseline } from './changed-files-baseline.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('captureChangedFilesBaseline', () => {
  itUnix('treats symlinked changed files as missing fingerprints', async () => {
    const dir = createTempDir('changed-files-baseline-symlink');
    const outside = createTempDir('changed-files-baseline-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));

      const baseline = await captureChangedFilesBaseline(dir, ['src/leak.ts']);
      expect(baseline.get('src/leak.ts')).toBe('missing');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});
