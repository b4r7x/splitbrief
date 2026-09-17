import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readConfinedEntry, sameFileEntry, writeConfinedEntry } from './entry.js';
import type { FileSnapshotEntry } from './entry.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function fileEntry(bytes: Buffer, mode: number): FileSnapshotEntry {
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode };
}

describe('confined file snapshot entries', () => {
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
});
