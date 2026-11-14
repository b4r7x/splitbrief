import { describe, expect } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureAcquisitionBaseline, matchesAcquisitionBaseline } from './baseline.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { itUnix } from '#testing/helpers/file-snapshot-entry.js';

describe('confined file snapshot entries', () => {
  itUnix('matches a file against the acquisition baseline but never a symlink', async () => {
    const left = createTempDir('entry-match-left');
    try {
      writeFileSync(join(left, 'real.txt'), 'real');
      symlinkSync('real.txt', join(left, 'link'));
      const baseline = await captureAcquisitionBaseline(left);

      expect(await matchesAcquisitionBaseline(left, 'real.txt', baseline)).toBe(true);
      expect(await matchesAcquisitionBaseline(left, 'link', baseline)).toBe(false);
    } finally {
      cleanupTempDir(left);
    }
  });
});
