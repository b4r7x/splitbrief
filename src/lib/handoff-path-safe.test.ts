import { describe, it, expect } from 'vitest';
import { assertHandoffPathSafe } from './handoff-path-safe.js';

const ROOT = '/safe/output/dir';

describe('assertHandoffPathSafe', () => {
  it('does not throw for a safe relative path', () => {
    expect(() => assertHandoffPathSafe('tasks/T001.md', ROOT)).not.toThrow();
  });

  it('does not throw for a nested safe relative path', () => {
    expect(() => assertHandoffPathSafe('a/b/c.md', ROOT)).not.toThrow();
  });

  it('does not throw for a top-level filename', () => {
    expect(() => assertHandoffPathSafe('README.md', ROOT)).not.toThrow();
  });

  it('throws for a path with .. traversal (../escape.md)', () => {
    expect(() => assertHandoffPathSafe('../escape.md', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a nested .. traversal (tasks/../../escape.md)', () => {
    expect(() => assertHandoffPathSafe('tasks/../../escape.md', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for an absolute path', () => {
    expect(() => assertHandoffPathSafe('/etc/passwd', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a Windows drive absolute path on POSIX', () => {
    expect(() => assertHandoffPathSafe('C:\\windows\\system32', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a Windows UNC absolute path on POSIX', () => {
    expect(() => assertHandoffPathSafe('\\\\server\\share\\file.md', ROOT)).toThrow(/unsafe path/);
  });

  it('throws for a deeply nested .. that escapes the root', () => {
    expect(() => assertHandoffPathSafe('tasks/../../../safe', ROOT)).toThrow(/unsafe path/);
  });
});
