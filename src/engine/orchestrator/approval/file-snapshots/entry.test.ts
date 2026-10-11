import { afterEach, describe, it, expect, vi } from 'vitest';
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
import { basename, join } from 'node:path';
import {
  captureAcquisitionBaseline,
  entriesMatch,
  matchesAcquisitionBaseline,
  readConfinedEntry,
  readProjectSymlink,
  sameFileEntry,
  writeConfinedEntry,
  writeConfinedSymlink,
} from './entry.js';
import type { FileSnapshotEntry } from './entry.js';
import { restoreDirtyFilesFromSnapshot } from './restore.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

afterEach(() => vi.restoreAllMocks());

function fileEntry(bytes: Buffer, mode: number): FileSnapshotEntry {
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode };
}

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

  itUnix('reads a symlink target only when the link stays inside the project', async () => {
    const dir = createTempDir('entry-project-link');
    const outside = createTempDir('entry-project-link-outside');
    try {
      mkdirSync(join(dir, 'skills', 'babysit'), { recursive: true });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      writeFileSync(join(dir, 'plain.txt'), 'plain');
      symlinkSync('../../skills/babysit', join(dir, '.claude', 'skills', 'babysit'), 'dir');
      symlinkSync('missing.txt', join(dir, 'dangling.txt'));
      symlinkSync(join(dir, 'skills'), join(dir, 'absolute'), 'dir');
      symlinkSync(`../${basename(outside)}`, join(dir, 'escaping'), 'dir');
      symlinkSync(outside, join(dir, 'exit'), 'dir');
      symlinkSync('exit/secret.txt', join(dir, 'through-exit.txt'));
      // Back inside only through the root's own name, which a copy of the tree does not share.
      symlinkSync(`../${basename(dir)}/plain.txt`, join(dir, 'climbing.txt'));

      expect(await readProjectSymlink(dir, '.claude/skills/babysit')).toBe('../../skills/babysit');
      expect(await readProjectSymlink(dir, 'dangling.txt')).toBe('missing.txt');
      for (const file of [
        'absolute',
        'escaping',
        'exit',
        'through-exit.txt',
        'climbing.txt',
        'plain.txt',
        'none',
      ]) {
        expect(await readProjectSymlink(dir, file)).toBeNull();
      }
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  // The kernel resolves a name before the `..` after it, so `sub/..` climbs from
  // wherever `sub` points, never from where the spelling says.
  itUnix(
    'reads a link target by where the kernel lands it: inside the root, outside the control plane',
    async () => {
      const root = createTempDir('entry-link-landing');
      const dir = join(root, 'project');
      try {
        mkdirSync(join(dir, 'a', 'b'), { recursive: true });
        mkdirSync(join(dir, '.git'));
        mkdirSync(join(root, 'outside'));
        writeFileSync(join(root, 'outside', 'secret'), 'secret');
        writeFileSync(join(dir, 'real.txt'), 'real');
        symlinkSync('.', join(dir, 'sub'));
        symlinkSync('..', join(dir, 'a', 'up'));
        symlinkSync('sub/../outside/secret', join(dir, 'evil'));
        symlinkSync('a/up/../outside/secret', join(dir, 'evil-up'));
        symlinkSync('sub/../outside/missing', join(dir, 'evil-dangling'));
        symlinkSync('../../outside/secret', join(dir, 'a', 'hop'));
        symlinkSync('a/hop', join(dir, 'chain'));
        symlinkSync('.git', join(dir, 'gitlink'));
        symlinkSync('../.git', join(dir, 'a', 'gitlink'));
        symlinkSync('.git/missing', join(dir, 'gitlink-dangling'));
        symlinkSync('loop-b', join(dir, 'loop-a'));
        symlinkSync('loop-a', join(dir, 'loop-b'));
        symlinkSync('..', join(dir, 'a', 'b', 'up'));
        symlinkSync('.', join(dir, 'a', 'self'));
        symlinkSync('real.txt', join(dir, 'plain-link'));

        expect(await readProjectSymlink(dir, 'sub')).toBe('.');
        expect(await readProjectSymlink(dir, 'a/up')).toBe('..');
        expect(await readProjectSymlink(dir, 'a/b/up')).toBe('..');
        expect(await readProjectSymlink(dir, 'a/self')).toBe('.');
        expect(await readProjectSymlink(dir, 'plain-link')).toBe('real.txt');
        for (const file of [
          'evil',
          'evil-up',
          'evil-dangling',
          'chain',
          'gitlink',
          'a/gitlink',
          'gitlink-dangling',
          'loop-a',
        ]) {
          expect(await readProjectSymlink(dir, file), file).toBeNull();
        }
      } finally {
        cleanupTempDir(root);
      }
    },
  );

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
