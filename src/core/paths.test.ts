import { describe, it, expect } from 'vitest';
import {
  INTERNAL_SKIP_DIRS,
  isInternalGitStatusPath,
  DIPTYCH_DIR,
  SANDBOX_DIR,
  TREES_DIR,
} from './paths.js';

describe('INTERNAL_SKIP_DIRS', () => {
  it('is the single base set of never-touch directories', () => {
    expect(INTERNAL_SKIP_DIRS).toEqual([
      '.git',
      DIPTYCH_DIR,
      SANDBOX_DIR,
      'node_modules',
      TREES_DIR,
    ]);
  });
});

describe('isInternalGitStatusPath', () => {
  it('matches the internal artifact directories at the top level', () => {
    expect(isInternalGitStatusPath('.diptych/state.json')).toBe(true);
    expect(isInternalGitStatusPath('.diptych-sandbox/x')).toBe(true);
    expect(isInternalGitStatusPath('.trees/feat/src/a.ts')).toBe(true);
  });

  it('matches the bare directory entry from porcelain output', () => {
    expect(isInternalGitStatusPath('.trees')).toBe(true);
    expect(isInternalGitStatusPath('.trees/')).toBe(true);
  });

  it('matches an internal directory nested under a subdirectory', () => {
    expect(isInternalGitStatusPath('sub/.trees/feat/a.ts')).toBe(true);
    expect(isInternalGitStatusPath('packages/app/.diptych/config.yaml')).toBe(true);
  });

  it('does not match ordinary project files', () => {
    expect(isInternalGitStatusPath('src/a.ts')).toBe(false);
    expect(isInternalGitStatusPath('.gitignore')).toBe(false);
    expect(isInternalGitStatusPath('docs/.trees-notes.md')).toBe(false);
  });
});
