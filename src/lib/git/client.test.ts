import { describe, it, expect, afterEach } from 'vitest';
import { getCurrentDiff } from './diff.js';
import { gitError } from './client.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    cleanupTempDir(d);
  }
  dirs = [];
});

function tracked(dir: string) {
  dirs.push(dir);
  return dir;
}

describe('runGit error wrapping', () => {
  it('wraps a failed simple-git call as a typed GitCommandError', async () => {
    const dir = tracked(createTempDir('splitbrief-nogit-diff'));
    await expect(getCurrentDiff(dir)).rejects.toMatchObject({ kind: 'git-command-failed' });
  });
});

describe('gitError', () => {
  it('creates a discriminated AppError for failed commands', () => {
    const err = gitError.commandFailed('rev-parse HEAD', 'not a git repository');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('git-command-failed');
    expect(err.message).toContain('rev-parse HEAD');
    expect(err.message).toContain('not a git repository');
    expect(err.data).toEqual({ intent: 'rev-parse HEAD', causeMessage: 'not a git repository' });
  });
});
