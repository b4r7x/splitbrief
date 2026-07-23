import { mkdir } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createWorktree } from './worktree/create.js';
import { removeWorktree } from './worktree/remove.js';
import { TREES_DIR } from '../core/paths.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('worktree path confinement', () => {
  itUnix('rejects create when .trees is a symlink outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'worktree-outside-'));
    const project = mkdtempSync(join(tmpdir(), 'worktree-project-'));
    try {
      createTestGitRepo(project, { 'README.md': '# test\n' });
      const projectGit = simpleGit(project);
      symlinkSync(outside, join(project, TREES_DIR));
      await expect(
        createWorktree({ projectDir: project, slug: 'escape', git: projectGit }),
      ).rejects.toThrow('resolves outside the project root');
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  itUnix('rejects remove when .trees/<slug> resolves outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'worktree-outside-'));
    const project = mkdtempSync(join(tmpdir(), 'worktree-project-'));
    try {
      createTestGitRepo(project, { 'README.md': '# test\n' });
      const projectGit = simpleGit(project);
      await mkdir(join(project, TREES_DIR), { recursive: true });
      symlinkSync(outside, join(project, TREES_DIR, 'escape'));
      await expect(
        removeWorktree({ projectDir: project, slug: 'escape', git: projectGit }),
      ).rejects.toThrow('resolves outside the project root');
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
