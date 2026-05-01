import { describe, it, expect } from 'vitest';
import { assertPathConfined } from './path-confinement.js';

const ROOT = '/safe/root/dir';

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
});
