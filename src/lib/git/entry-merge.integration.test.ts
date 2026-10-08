import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeFileEntries } from './entry-merge.js';

const text = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`);
const spawn = childProcess.spawn;
const mergedBytes = Buffer.from([255, 97, 10]);

beforeEach(() => {
  vi.spyOn(fs, 'mkdtemp');
  syncBuiltinESMExports();
});

afterEach(async () => {
  try {
    for (const result of vi.mocked(fs.mkdtemp).mock.results) {
      if (result.type === 'return') {
        const root = await result.value;
        try {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

function replaceGitWith(command: string, args: string[]) {
  const replacement = vi
    .spyOn(childProcess, 'spawn')
    .mockImplementation((_command, _args, options) => spawn(command, args, options));
  syncBuiltinESMExports();
  return replacement;
}

describe('mergeFileEntries', () => {
  it('clean merge of disjoint hunks', async () => {
    const result = await mergeFileEntries({
      base: text(['one', 'two', 'three', 'four', 'five']),
      ours: text(['ONE', 'two', 'three', 'four', 'five']),
      theirs: text(['one', 'two', 'three', 'four', 'FIVE']),
    });
    expect(result).toEqual({
      kind: 'clean',
      bytes: text(['ONE', 'two', 'three', 'four', 'FIVE']),
    });
  });

  it('same-hunk edit is a conflict with markers', async () => {
    const result = await mergeFileEntries({
      base: text(['a', 'b', 'c']),
      ours: text(['A', 'b', 'c']),
      theirs: text(['X', 'b', 'c']),
    });
    expect(result).toEqual({
      kind: 'conflict',
      count: 1,
      bytes: text([
        '<<<<<<< ours',
        'A',
        '||||||| base',
        'a',
        '=======',
        'X',
        '>>>>>>> theirs',
        'b',
        'c',
      ]),
    });
  });

  it('binary input is unmergeable', async () => {
    const result = await mergeFileEntries({
      base: text(['a', 'b']),
      ours: Buffer.from([0x61, 0x00, 0x62]),
      theirs: text(['a', 'c']),
    });
    expect(result).toEqual({ kind: 'unmergeable' });
  });

  it.each(['base', 'ours', 'theirs'])(
    'rejects NUL in %s before creating files or a process',
    async (side) => {
      const creation = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        throw new Error('Unexpected merge process');
      });
      syncBuiltinESMExports();

      await expect(
        mergeFileEntries({
          base: text(['base']),
          ours: text(['ours']),
          theirs: text(['theirs']),
          [side]: Buffer.from([0x61, 0x00, 0x62]),
        }),
      ).resolves.toEqual({ kind: 'unmergeable' });
      expect(fs.mkdtemp).not.toHaveBeenCalled();
      expect(creation).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: 0, expected: { kind: 'clean', bytes: mergedBytes } },
    { code: 2, expected: { kind: 'conflict', bytes: mergedBytes, count: 2 } },
    { code: 127, expected: { kind: 'conflict', bytes: mergedBytes, count: 127 } },
    { code: 128, expected: { kind: 'unmergeable' } },
    { code: 255, expected: { kind: 'unmergeable' } },
  ])('classifies exit $code and removes temporary files', async ({ code, expected }) => {
    replaceGitWith(process.execPath, [
      '-e',
      `process.stdout.write(Buffer.from([255, 97, 10])); process.exitCode = ${code};`,
    ]);

    const result = await mergeFileEntries({
      base: text(['base']),
      ours: text(['ours']),
      theirs: text(['theirs']),
    });
    expect(result).toEqual(expected);
    expect(fs.mkdtemp).toHaveBeenCalledOnce();
  });

  it('propagates a spawn failure and removes temporary files', async () => {
    replaceGitWith(join(dirname(process.execPath), 'splitbrief-missing-merge-executable'), []);

    await expect(
      mergeFileEntries({ base: text(['base']), ours: text(['ours']), theirs: text(['theirs']) }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.mkdtemp).toHaveBeenCalledOnce();
  });

  it('propagates a synchronous spawn failure and removes temporary files', async () => {
    const failure = new Error('Could not spawn merge process');
    replaceGitWith(process.execPath, []).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      mergeFileEntries({ base: text(['base']), ours: text(['ours']), theirs: text(['theirs']) }),
    ).rejects.toBe(failure);
    expect(fs.mkdtemp).toHaveBeenCalledOnce();
  });

  it('rejects signal termination and removes temporary files', async () => {
    replaceGitWith(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM');"]);

    await expect(
      mergeFileEntries({ base: text(['base']), ours: text(['ours']), theirs: text(['theirs']) }),
    ).rejects.toMatchObject({
      kind: 'entry-merge-failed',
      message: 'Could not merge captured entries',
    });
    expect(fs.mkdtemp).toHaveBeenCalledOnce();
  });

  it('identical sides are clean', async () => {
    const same = text(['same', 'bytes']);
    const result = await mergeFileEntries({ base: same, ours: same, theirs: same });
    expect(result).toEqual({ kind: 'clean', bytes: same });
  });
});
