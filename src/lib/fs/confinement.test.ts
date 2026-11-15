import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  isInsideRoot,
  isPathConfined,
  nearestExistingAncestor,
} from './confinement.js';

const ROOT = '/safe/root/dir';
const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('assertPathConfined', () => {
  it.each(['tasks/T001.md', 'a/b/c.md', 'README.md'])('does not throw for %s', (path) => {
    expect(() => assertPathConfined(path, ROOT)).not.toThrow();
  });

  it.each([
    ['.. traversal', '../escape.md'],
    ['nested .. traversal', 'tasks/../../escape.md'],
    ['absolute path', '/etc/passwd'],
    ['deeply nested .. that escapes root', 'tasks/../../../safe'],
    ['Windows drive absolute path', 'C:\\windows\\system32'],
    ['Windows drive with forward slashes', 'C:/windows/system32'],
    ['Windows UNC absolute path', '\\\\server\\share\\file.md'],
  ])('throws for %s (%s)', (_label, path) => {
    expect(() => assertPathConfined(path, ROOT)).toThrow(/unsafe path/);
  });

  itUnix('rejects existing symlinks that resolve outside the root', () => {
    const root = createTempDir('path-conf-root');
    const outside = createTempDir('path-conf-outside');
    tmpDirs.push(root, outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));

    expect(() => assertExistingPathConfined('linked.txt', root)).toThrow(/unsafe path/);
  });

  itUnix('rejects writes through symlinked parent directories outside the root', () => {
    const root = createTempDir('path-conf-root');
    const outside = createTempDir('path-conf-outside');
    tmpDirs.push(root, outside);
    mkdirSync(join(outside, 'target'), { recursive: true });
    symlinkSync(join(outside, 'target'), join(root, 'linked-dir'));

    expect(() => assertWritablePathConfined('linked-dir/file.ts', root)).toThrow(/unsafe path/);
  });
});

describe('isPathConfined', () => {
  it('recognizes a nested path as confined and an escaping path as not', () => {
    expect(isPathConfined('handoffs/spec-kit', ROOT)).toBe(true);
    expect(isPathConfined('', ROOT)).toBe(true);
    expect(isPathConfined('../escape', ROOT)).toBe(false);
  });

  it('rejects Windows drive-absolute paths regardless of separator', () => {
    expect(isPathConfined('C:\\windows', ROOT)).toBe(false);
    expect(isPathConfined('C:/windows', ROOT)).toBe(false);
  });

  it('refuses a path under a root of /', () => {
    expect(isPathConfined('etc/x', '/')).toBe(false);
  });
});

describe('isInsideRoot', () => {
  it('treats the root itself and descendants as inside', () => {
    expect(isInsideRoot('/a/b', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b', '/a/b/c')).toBe(true);
    expect(isInsideRoot('/a/b', '/a/b/c/d.txt')).toBe(true);
  });

  it('treats siblings and ancestors as outside', () => {
    expect(isInsideRoot('/a/b', '/a/c')).toBe(false);
    expect(isInsideRoot('/a/b', '/a')).toBe(false);
    expect(isInsideRoot('/a/b', '/x/y')).toBe(false);
  });
});

describe('nearestExistingAncestor', () => {
  itUnix('resolves an existing path to its realpath', () => {
    const root = createTempDir('near-root');
    tmpDirs.push(root);
    mkdirSync(join(root, 'present'), { recursive: true });
    const alias = join(root, 'present-link');
    symlinkSync(join(root, 'present'), alias);
    expect(nearestExistingAncestor(alias)).toBe(realpathSync(join(root, 'present')));
  });

  itUnix('walks up to the nearest existing ancestor for a missing leaf', () => {
    const root = createTempDir('near-missing');
    tmpDirs.push(root);
    const realRoot = nearestExistingAncestor(root);
    expect(nearestExistingAncestor(join(root, 'a', 'b', 'c'))).toBe(realRoot);
  });
});
