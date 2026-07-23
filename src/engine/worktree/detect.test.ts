import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createWorktree } from './create.js';
import { detectWorktree } from './detect.js';
import { TREES_DIR } from '../../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  createTestGitRepo(dir, { 'README.md': '# test\n' });
  return simpleGit(dir);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-detect-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('detectWorktree', () => {
  it('returns null in the main worktree', async () => {
    const result = await detectWorktree(repoDir, git);
    expect(result).toBeNull();
  });

  it('returns the slug when called from inside a linked worktree', async () => {
    const slug = 'feat-m';
    await createWorktree({ projectDir: repoDir, slug, git });
    const wtPath = join(repoDir, TREES_DIR, slug);
    const wtGit = simpleGit(wtPath);
    const result = await detectWorktree(wtPath, wtGit);
    expect(result).toBe(slug);
  });

  it('returns null on error (non-git directory)', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'not-a-git-'));
    try {
      const nonGit = simpleGit(nonGitDir);
      const result = await detectWorktree(nonGitDir, nonGit);
      expect(result).toBeNull();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});
