import { afterEach, describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  confinedAppendFileSync,
  confinedEnsureDir,
  confinedReadFile,
  confinedReadFileAsync,
  confinedReplaceFile,
  confinedWriteFile,
  confinedWriteFileInExistingDirAsync,
} from './confined.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('confinedReadFile', () => {
  it('returns the file contents for a readable in-root file', () => {
    const root = createTempDir('confined-sync-read');
    tmpDirs.push(root);
    writeFileSync(join(root, 'note.md'), 'hello');

    expect(confinedReadFile(root, 'note.md')).toBe('hello');
  });

  it('returns null for a missing file', () => {
    const root = createTempDir('confined-sync-missing');
    tmpDirs.push(root);

    expect(confinedReadFile(root, 'absent.md')).toBeNull();
  });

  it('propagates a read failure instead of reporting it as a missing file', () => {
    const root = createTempDir('confined-sync-eisdir');
    tmpDirs.push(root);
    mkdirSync(join(root, 'a-directory'));

    expect(() => confinedReadFile(root, 'a-directory')).toThrow(
      expect.objectContaining({ code: 'EISDIR' }),
    );
  });

  it('propagates path-confinement errors for escaping paths', () => {
    const root = createTempDir('confined-sync-escape');
    tmpDirs.push(root);

    expect(() => confinedReadFile(root, '../escape.md')).toThrow(
      expect.objectContaining({ kind: 'path-confined-escape' }),
    );
  });

  itUnix('propagates a symlink-read rejection for an in-root symlink', () => {
    const root = createTempDir('confined-sync-symlink');
    tmpDirs.push(root);
    writeFileSync(join(root, 'real.md'), 'secret');
    symlinkSync(join(root, 'real.md'), join(root, 'linked.md'));

    expect(() => confinedReadFile(root, 'linked.md')).toThrow(
      expect.objectContaining({ kind: 'path-symlink-read' }),
    );
  });
});

describe('confinedReadFileAsync', () => {
  it('returns the file contents for a readable in-root file', async () => {
    const root = createTempDir('confined-async-read');
    tmpDirs.push(root);
    writeFileSync(join(root, 'note.md'), 'hello');

    await expect(confinedReadFileAsync(root, 'note.md')).resolves.toBe('hello');
  });

  it('returns null for a missing file', async () => {
    const root = createTempDir('confined-async-missing');
    tmpDirs.push(root);

    await expect(confinedReadFileAsync(root, 'absent.md')).resolves.toBeNull();
  });

  it('rejects on a read failure instead of reporting it as a missing file', async () => {
    const root = createTempDir('confined-async-eisdir');
    tmpDirs.push(root);
    mkdirSync(join(root, 'a-directory'));

    await expect(confinedReadFileAsync(root, 'a-directory')).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('propagates path-confinement errors for escaping paths', async () => {
    const root = createTempDir('confined-async-escape');
    tmpDirs.push(root);

    await expect(confinedReadFileAsync(root, '../escape.md')).rejects.toMatchObject({
      kind: 'path-confined-escape',
    });
  });

  itUnix('propagates a symlink-read rejection for an in-root symlink', async () => {
    const root = createTempDir('confined-async-symlink');
    tmpDirs.push(root);
    writeFileSync(join(root, 'real.md'), 'secret');
    symlinkSync(join(root, 'real.md'), join(root, 'linked.md'));

    await expect(confinedReadFileAsync(root, 'linked.md')).rejects.toMatchObject({
      kind: 'path-symlink-read',
    });
  });
});

describe.each([
  ['confinedWriteFile', confinedWriteFile],
  ['confinedAppendFileSync', confinedAppendFileSync],
])('%s', (_name, write) => {
  it('refuses a root folder that is gone and makes no folder', () => {
    const parent = createTempDir('confined-root-gone');
    tmpDirs.push(parent);
    const root = join(parent, 'project');

    expect(() => write(root, join('.splitbrief', 'sessions', 'draft.json'), 'words')).toThrow(
      expect.objectContaining({
        kind: 'path-confined-root-missing',
        message: `the project folder ${root} is gone`,
      }),
    );
    expect(existsSync(root)).toBe(false);
  });

  it('makes the folders below a root folder that exists', () => {
    const root = createTempDir('confined-root-present');
    tmpDirs.push(root);

    write(root, join('.splitbrief', 'sessions', 'draft.json'), 'words');

    expect(readFileSync(join(root, '.splitbrief', 'sessions', 'draft.json'), 'utf8')).toBe('words');
  });
});

describe('confinedWriteFileInExistingDirAsync', () => {
  it('writes into an existing parent directory', async () => {
    const root = createTempDir('confined-write-existing-dir');
    tmpDirs.push(root);
    mkdirSync(join(root, '.splitbrief'));
    const relativePath = join('.splitbrief', 'cache.json');

    await confinedWriteFileInExistingDirAsync(root, relativePath, 'cache');

    expect(readFileSync(join(root, relativePath), 'utf8')).toBe('cache');
  });

  it.each(['parent', 'project root'])('creates nothing when the %s is missing', async (missing) => {
    const tempDir = createTempDir('confined-write-missing-dir');
    tmpDirs.push(tempDir);
    const root = join(tempDir, 'project');
    const parent = join(root, '.splitbrief');
    if (missing === 'parent') mkdirSync(root);

    await expect
      .soft(confinedWriteFileInExistingDirAsync(root, join('.splitbrief', 'cache.json'), 'cache'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(existsSync(missing === 'parent' ? parent : root)).toBe(false);
  });
});

describe('confinedEnsureDir', () => {
  it('refuses a root folder that is gone and makes no folder', () => {
    const parent = createTempDir('confined-dir-root-gone');
    tmpDirs.push(parent);
    const root = join(parent, 'project');

    expect(() => confinedEnsureDir(root, join('.splitbrief', 'sessions', 'run'))).toThrow(
      expect.objectContaining({
        kind: 'path-confined-root-missing',
        message: `the project folder ${root} is gone`,
      }),
    );
    expect(existsSync(root)).toBe(false);
  });

  it('makes the folders below a root folder that exists', () => {
    const root = createTempDir('confined-dir-root-present');
    tmpDirs.push(root);

    confinedEnsureDir(root, join('.splitbrief', 'sessions', 'run'));

    expect(statSync(join(root, '.splitbrief', 'sessions', 'run')).isDirectory()).toBe(true);
  });
});

describe('confinedReplaceFile', () => {
  it('names the file it meant, not its temporary copy, when the folder refuses the write', async () => {
    const root = createTempDir('confined-replace-refused');
    tmpDirs.push(root);
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'yarn.lock'), 'base');
    chmodSync(join(root, 'pkg'), 0o555);
    try {
      await expect(confinedReplaceFile(root, 'pkg/yarn.lock', 'ours', 0o644)).rejects.toMatchObject(
        { code: 'EACCES', path: join(root, 'pkg', 'yarn.lock') },
      );
    } finally {
      chmodSync(join(root, 'pkg'), 0o755);
    }
  });
});
