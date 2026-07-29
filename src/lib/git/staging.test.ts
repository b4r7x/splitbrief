import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { getStagedFiles, createTaggedStash } from './staging.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('splitbrief-git-test');
  createTestGitRepo(dir);
  return dir;
}

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

describe('getStagedFiles', () => {
  it('returns the staged path verbatim for a non-ASCII filename', async () => {
    const dir = tracked(setupGitRepo());
    const git = simpleGit(dir);
    writeFileSync(join(dir, 'café.ts'), 'export {}');
    await git.add(['--', 'café.ts']);

    const staged = await getStagedFiles(dir);
    expect(staged).toContain('café.ts');
  });
});

describe('createTaggedStash', () => {
  it('preserves the staged/unstaged split across a successful checkpoint', async () => {
    const dir = tracked(setupGitRepo());
    const git = simpleGit(dir);
    writeFileSync(join(dir, 'staged.txt'), 'staged by user');
    writeFileSync(join(dir, 'unstaged.txt'), 'left in working tree');
    await git.add(['--', 'staged.txt']);

    const tag = await createTaggedStash(dir, 'splitbrief checkpoint: T001', 'splitbrief/T001');
    expect(tag).toBe('splitbrief/T001');

    const tags = await git.tags();
    expect(tags.all).toContain('splitbrief/T001');
    const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
    expect(stagedAfter).toBe('staged.txt');
    expect(existsSync(join(dir, 'staged.txt'))).toBe(true);
    expect(existsSync(join(dir, 'unstaged.txt'))).toBe(true);
  });

  it('restores the clean pre-stage index when tag creation fails', async () => {
    const dir = tracked(setupGitRepo());
    const git = simpleGit(dir);
    writeFileSync(join(dir, 'seed.txt'), 'seed');
    await git.add('seed.txt');
    const seedSha = (await git.raw(['stash', 'create', 'seed stash'])).trim();
    await git.tag(['splitbrief/T001', seedSha]);
    await git.reset(['--mixed', 'HEAD']);

    writeFileSync(join(dir, 'staged.txt'), 'new content');

    await expect(
      createTaggedStash(dir, 'splitbrief checkpoint: T001', 'splitbrief/T001'),
    ).rejects.toMatchObject({ kind: 'git-command-failed' });

    const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
    expect(stagedAfter).toBe('');
  });
});
