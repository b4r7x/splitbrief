import { afterEach, describe, it, expect } from 'vitest';
import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  assertExistingPathConfined,
  assertModelWritablePathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  isInsideRoot,
  isPathConfined,
  nearestExistingAncestor,
} from './path-confinement.js';

const ROOT = '/safe/root/dir';
const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('assertPathConfined', () => {
  it('does not throw for a safe relative path', () => {
    expect(() => assertPathConfined('tasks/T001.md', ROOT)).not.toThrow();
  });

  it('does not throw for a nested safe relative path', () => {
    expect(() => assertPathConfined('a/b/c.md', ROOT)).not.toThrow();
  });

  it('does not throw for a top-level filename', () => {
    expect(() => assertPathConfined('README.md', ROOT)).not.toThrow();
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

describe('assertModelWritablePathConfined — control plane', () => {
  it.each([
    ['.git/config', '.git/config'],
    ['nested .git path', '.git/hooks/pre-commit'],
    ['.splitbrief/config.yaml', '.splitbrief/config.yaml'],
    ['nested .splitbrief path', '.splitbrief/sessions/s/state.json'],
  ])('rejects model-named write to %s', (_label, path) => {
    const root = createTempDir('path-conf-cp-root');
    tmpDirs.push(root);
    expect(() => assertModelWritablePathConfined(path, root)).toThrow(/control plane/);
  });

  it('still allows ordinary in-repo source paths', () => {
    const root = createTempDir('path-conf-cp-ok');
    tmpDirs.push(root);
    expect(() => assertModelWritablePathConfined('src/feature/foo.ts', root)).not.toThrow();
  });

  itUnix('rejects a model-named write reaching .git through an in-repo symlink', () => {
    const root = createTempDir('path-conf-cp-symlink');
    tmpDirs.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    symlinkSync(join(root, '.git'), join(root, 'evil'));

    expect(() => assertModelWritablePathConfined('evil/config', root)).toThrow(/control plane/);
  });

  itUnix('rejects a model-named write to a hardlink targeting a control-plane file', () => {
    const root = createTempDir('path-conf-cp-hardlink');
    tmpDirs.push(root);
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    linkSync(join(root, '.git', 'config'), join(root, 'innocent.txt'));

    expect(() => assertModelWritablePathConfined('innocent.txt', root)).toThrow(/hardlink/);
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
