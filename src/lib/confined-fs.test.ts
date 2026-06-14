import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { confinedReadFile, confinedReadFileAsync } from './confined-fs.js';

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

  it('returns null when the read itself fails instead of throwing', () => {
    const root = createTempDir('confined-sync-eisdir');
    tmpDirs.push(root);
    mkdirSync(join(root, 'a-directory'));

    expect(confinedReadFile(root, 'a-directory')).toBeNull();
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

  it('resolves to null when the async read itself fails instead of rejecting', async () => {
    const root = createTempDir('confined-async-eisdir');
    tmpDirs.push(root);
    mkdirSync(join(root, 'a-directory'));

    await expect(confinedReadFileAsync(root, 'a-directory')).resolves.toBeNull();
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
