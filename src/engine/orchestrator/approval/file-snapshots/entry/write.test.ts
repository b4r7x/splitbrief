import { afterEach, describe, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeConfinedEntry, writeConfinedSymlink } from './write.js';
import { readConfinedEntry } from './read.js';
import { restoreDirtyFilesFromSnapshot } from '../restore.js';
import { sha256Hex } from '../../../../../utils/sha256.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { fileEntry, itUnix } from '#testing/helpers/file-snapshot-entry.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

afterEach(() => vi.restoreAllMocks());

describe('confined file snapshot entries', () => {
  itUnix.each([true, false])(
    'leaves the target intact when restoration fsync fails, existing: %s',
    async (existing) => {
      const dir = createTempDir('entry-sync-failure');
      const failure = new Error('promotion fsync failed');
      const open = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        vi.spyOn(handle, 'sync').mockRejectedValue(failure);
        return handle;
      });
      try {
        if (existing) writeFileSync(join(dir, 'restored.txt'), 'keep');
        await expect(
          restoreDirtyFilesFromSnapshot(
            dir,
            {
              head: 'saved-head',
              files: [],
              dirtyFileContents: {},
              dirtyFileEntries: {
                'restored.txt': { base64: Buffer.from('restored').toString('base64'), mode: 0o755 },
              },
            },
            ['restored.txt'],
          ),
        ).rejects.toBe(failure);
        expect(readdirSync(dir)).toEqual(existing ? ['restored.txt'] : []);
        if (existing) expect(readFileSync(join(dir, 'restored.txt'), 'utf8')).toBe('keep');
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  itUnix('roundtrips binary bytes exactly and leaves inputs untouched', async () => {
    const dir = createTempDir('entry-roundtrip');
    try {
      const payloads = [
        ['asset.bin', Buffer.from([0, 255, 254, 128, 10])],
        ['tiny.bin', Buffer.from([0, 255, 10])],
      ] as const;
      for (const [name, payload] of payloads) {
        const before = Buffer.from(payload);
        await writeConfinedEntry(dir, name, fileEntry(payload, 0o644));
        const read = await readConfinedEntry(dir, name);
        expect(read).toMatchObject({ kind: 'file', sha256: sha256Hex(payload), mode: 0o644 });
        expect(read.kind === 'file' && read.bytes.equals(payload)).toBe(true);
        expect(payload.equals(before)).toBe(true);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('creates and deletes through absent entries', async () => {
    const dir = createTempDir('entry-absent');
    try {
      expect(await readConfinedEntry(dir, 'made.bin')).toEqual({ kind: 'absent' });
      await writeConfinedEntry(dir, 'made.bin', fileEntry(Buffer.from([1, 2]), 0o644));
      expect(existsSync(join(dir, 'made.bin'))).toBe(true);
      await writeConfinedEntry(dir, 'made.bin', { kind: 'absent' });
      expect(existsSync(join(dir, 'made.bin'))).toBe(false);
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('applies ordinary permission bits and masks special bits', async () => {
    const dir = createTempDir('entry-mode');
    try {
      const script = Buffer.from('#!/bin/sh\nexit 0\n');
      await writeConfinedEntry(dir, 'run.sh', fileEntry(script, 0o755));
      expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755);
      await writeConfinedEntry(dir, 'run.sh', fileEntry(script, 0o644));
      expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o644);
      await writeConfinedEntry(dir, 'tool.sh', fileEntry(script, 0o4755));
      expect(statSync(join(dir, 'tool.sh')).mode & 0o7777).toBe(0o755);
      chmodSync(join(dir, 'tool.sh'), 0o4755);
      const read = await readConfinedEntry(dir, 'tool.sh');
      expect(read.kind === 'file' && read.mode === 0o755).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('rejects a directory before write and read', async () => {
    const dir = createTempDir('entry-dir');
    try {
      mkdirSync(join(dir, 'nested'));
      const write = writeConfinedEntry(dir, 'nested', fileEntry(Buffer.from([1]), 0o644));
      await expect(write).rejects.toThrow(/must be a regular file/);
      await expect(writeConfinedEntry(dir, 'nested', { kind: 'absent' })).rejects.toThrow(
        /must be a regular file/,
      );
      await expect(readConfinedEntry(dir, 'nested')).rejects.toThrow(/must be a regular file/);
      expect(readdirSync(join(dir, 'nested'))).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('rejects symlink escapes and in-root symlinks before write', async () => {
    const dir = createTempDir('entry-link');
    const outside = createTempDir('entry-link-outside');
    try {
      const secret = join(outside, 'secret.txt');
      writeFileSync(secret, 'keep-me');
      symlinkSync(secret, join(dir, 'leak.ts'));
      await expect(
        writeConfinedEntry(dir, 'leak.ts', fileEntry(Buffer.from([1]), 0o644)),
      ).rejects.toThrow(/unsafe path/);
      await expect(writeConfinedEntry(dir, 'leak.ts', { kind: 'absent' })).rejects.toThrow(
        /refusing to read through symlink/,
      );
      await expect(readConfinedEntry(dir, 'leak.ts')).rejects.toThrow(
        /refusing to read through symlink/,
      );
      expect(readFileSync(secret, 'utf-8')).toBe('keep-me');
      writeFileSync(join(dir, 'real.txt'), 'inside');
      symlinkSync(join(dir, 'real.txt'), join(dir, 'inner.ts'));
      await expect(
        writeConfinedEntry(dir, 'inner.ts', fileEntry(Buffer.from([1]), 0o644)),
      ).rejects.toThrow(/refusing to write through symlink/);
      await expect(readConfinedEntry(dir, 'inner.ts')).rejects.toThrow(
        /refusing to read through symlink/,
      );
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix(
    'writes a symlink over a missing, file or link entry, never over a directory or outside the root',
    async () => {
      const dir = createTempDir('entry-write-link');
      try {
        await writeConfinedSymlink(dir, '.claude/skills/babysit', '../../skills/babysit');
        writeFileSync(join(dir, 'replaced'), 'file');
        await writeConfinedSymlink(dir, 'replaced', 'plain.txt');
        await writeConfinedSymlink(dir, 'replaced', 'other.txt');
        mkdirSync(join(dir, 'kept', 'inner'), { recursive: true });

        expect(readlinkSync(join(dir, '.claude', 'skills', 'babysit'))).toBe(
          '../../skills/babysit',
        );
        expect(readlinkSync(join(dir, 'replaced'))).toBe('other.txt');
        await expect(writeConfinedSymlink(dir, 'kept', 'plain.txt')).rejects.toThrow();
        await expect(writeConfinedSymlink(dir, '../escaped', 'plain.txt')).rejects.toThrow(
          /unsafe path/,
        );
        expect(readdirSync(dir).sort()).toEqual(['.claude', 'kept', 'replaced']);
        expect(readdirSync(join(dir, 'kept'))).toEqual(['inner']);
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  itUnix('writes nothing into the control plane through a symlinked parent', async () => {
    const dir = createTempDir('entry-write-control-plane');
    try {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      symlinkSync('.git/hooks', join(dir, 'ops'), 'dir');

      for (const write of [
        () => writeConfinedEntry(dir, 'ops/nested/pre-commit', fileEntry(Buffer.from('x'), 0o755)),
        () => writeConfinedSymlink(dir, 'ops/pre-commit', 'hook.sh'),
      ]) {
        await expect(write()).rejects.toMatchObject({ kind: 'path-confined-control-plane' });
      }
      expect(readdirSync(join(dir, '.git', 'hooks'))).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
