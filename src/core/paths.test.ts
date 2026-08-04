import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { detachedBootstrapRoot, isInternalGitStatusPath } from './paths.js';

describe('detachedBootstrapRoot', () => {
  it('keeps temporary detached startup state outside final sessions', () => {
    const projectDir = join('repo', 'project');

    expect(detachedBootstrapRoot(projectDir)).toBe(join(projectDir, '.splitbrief', 'bootstrap'));
  });
});

describe('isInternalGitStatusPath', () => {
  it('matches the internal artifact directories at the top level', () => {
    expect(isInternalGitStatusPath('.splitbrief/state.json')).toBe(true);
    expect(isInternalGitStatusPath('.splitbrief/sandbox/x')).toBe(true);
    expect(isInternalGitStatusPath('.trees/feat/src/a.ts')).toBe(true);
  });

  it('matches the bare directory entry from porcelain output', () => {
    expect(isInternalGitStatusPath('.trees')).toBe(true);
    expect(isInternalGitStatusPath('.trees/')).toBe(true);
  });

  it('matches an internal directory nested under a subdirectory', () => {
    expect(isInternalGitStatusPath('sub/.trees/feat/a.ts')).toBe(true);
    expect(isInternalGitStatusPath('packages/app/.splitbrief/config.yaml')).toBe(true);
  });

  it('does not match ordinary project files', () => {
    expect(isInternalGitStatusPath('src/a.ts')).toBe(false);
    expect(isInternalGitStatusPath('.gitignore')).toBe(false);
    expect(isInternalGitStatusPath('docs/.trees-notes.md')).toBe(false);
  });
});
