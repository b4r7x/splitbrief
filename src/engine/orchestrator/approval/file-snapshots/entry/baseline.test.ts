import { describe, expect } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureAcquisitionBaseline,
  entriesMatch,
  matchesAcquisitionBaseline,
} from './baseline.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { itUnix } from '#testing/helpers/file-snapshot-entry.js';

describe('confined file snapshot entries', () => {
  itUnix(
    'matches a symlink only as the same project link, never through it or against the baseline',
    async () => {
      const left = createTempDir('entry-match-left');
      const right = createTempDir('entry-match-right');
      try {
        for (const dir of [left, right]) {
          writeFileSync(join(dir, 'real.txt'), 'real');
          symlinkSync('real.txt', join(dir, 'link'));
          symlinkSync(join(left, 'real.txt'), join(dir, 'absolute'));
        }
        symlinkSync('link', join(left, 'retargeted'));
        symlinkSync('real.txt', join(right, 'retargeted'));
        writeFileSync(join(left, 'replaced'), 'real');
        symlinkSync('real.txt', join(right, 'replaced'));
        const baseline = await captureAcquisitionBaseline(left);

        expect(await entriesMatch(left, right, 'link')).toBe(true);
        expect(await entriesMatch(left, right, 'real.txt')).toBe(true);
        for (const file of ['absolute', 'retargeted', 'replaced']) {
          expect(await entriesMatch(left, right, file), file).toBe(false);
        }
        expect(await matchesAcquisitionBaseline(left, 'real.txt', baseline)).toBe(true);
        expect(await matchesAcquisitionBaseline(left, 'link', baseline)).toBe(false);
      } finally {
        cleanupTempDir(right);
        cleanupTempDir(left);
      }
    },
  );
});
