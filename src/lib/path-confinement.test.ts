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

  it('throws for a path with .. traversal (../escape.md)', () => {
    expect(() => assertPathConfined('../escape.md', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a nested .. traversal (tasks/../../escape.md)', () => {
    expect(() => assertPathConfined('tasks/../../escape.md', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for an absolute path', () => {
    expect(() => assertPathConfined('/etc/passwd', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a deeply nested .. that escapes the root', () => {
    expect(() => assertPathConfined('tasks/../../../safe', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a Windows drive absolute path on POSIX', () => {
    expect(() => assertPathConfined('C:\\windows\\system32', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a Windows drive absolute path with forward slashes on POSIX', () => {
    expect(() => assertPathConfined('C:/windows/system32', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a Windows UNC absolute path on POSIX', () => {
    expect(() => assertPathConfined('\\\\server\\share\\file.md', ROOT)).toThrow(/unsafe path/);
  });
});
