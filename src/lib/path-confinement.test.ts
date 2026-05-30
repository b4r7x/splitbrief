import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
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
