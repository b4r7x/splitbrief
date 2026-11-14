import { describe, expect, it } from 'vitest';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FileSnapshotEntry, readChangeEntry, sameChangeEntry, sameFileEntry } from './read.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { fileEntry, itUnix } from '#testing/helpers/file-snapshot-entry.js';

describe('confined file snapshot entries', () => {
  itUnix('compares presence, digest and ordinary permission bits', () => {
    const absent: FileSnapshotEntry = { kind: 'absent' };
    const empty = fileEntry(Buffer.alloc(0), 0o644);
    const a = fileEntry(Buffer.from([1]), 0o644);
    const clone = fileEntry(Buffer.from([1]), 0o644);
    const otherBytes = fileEntry(Buffer.from([2]), 0o644);
    const exec = fileEntry(Buffer.from([1]), 0o755);
    const setuid = fileEntry(Buffer.from([1]), 0o4755);
    expect(sameFileEntry(absent, { kind: 'absent' })).toBe(true);
    expect(sameFileEntry(absent, empty)).toBe(false);
    expect(sameFileEntry(a, clone)).toBe(true);
    expect(sameFileEntry(a, otherBytes)).toBe(false);
    expect(sameFileEntry(a, exec)).toBe(false);
    expect(sameFileEntry(exec, setuid)).toBe(true);
  });

  itUnix('reads a change entry with a link by its target, never through it', async () => {
    const dir = createTempDir('change-entry');
    try {
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
      chmodSync(join(dir, 'run.sh'), 0o755);
      symlinkSync('run.sh', join(dir, 'live'));
      symlinkSync('missing.txt', join(dir, 'dangling'));

      expect(await readChangeEntry(dir, 'live')).toEqual({ kind: 'symlink', target: 'run.sh' });
      expect(await readChangeEntry(dir, 'dangling')).toEqual({
        kind: 'symlink',
        target: 'missing.txt',
      });
      expect(await readChangeEntry(dir, 'run.sh')).toEqual(
        fileEntry(Buffer.from('#!/bin/sh\n'), 0o755),
      );
      expect(await readChangeEntry(dir, 'absent.txt')).toEqual({ kind: 'absent' });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('compares change entries by link target, kind, bytes and mode', () => {
    const bytes = Buffer.from('same\n');
    const link = { kind: 'symlink', target: 'a.txt' } as const;
    expect(sameChangeEntry(link, { kind: 'symlink', target: 'a.txt' })).toBe(true);
    expect(sameChangeEntry(link, { kind: 'symlink', target: 'b.txt' })).toBe(false);
    expect(sameChangeEntry(link, fileEntry(Buffer.from('a.txt'), 0o644))).toBe(false);
    expect(sameChangeEntry({ kind: 'absent' }, link)).toBe(false);
    expect(sameChangeEntry(fileEntry(bytes, 0o644), fileEntry(bytes, 0o755))).toBe(false);
    expect(sameChangeEntry(fileEntry(bytes, 0o644), fileEntry(bytes, 0o644))).toBe(true);
  });
});
