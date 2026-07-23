import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DIPTYCH_DIR, CONFIG_FILE } from '../../core/paths.js';
import { ensureConfigGitignore } from '../../core/config/load/io.js';
import type { GitClient } from '../../lib/git/client.js';
import { worktreeError } from './errors.js';
import {
  gitignoreDiffersOnlyByDiptychBookkeeping,
  shouldIgnoreSourceDirtyPath,
} from './cleanliness.js';
import { resolveConfinedWorktreePath } from './path.js';

const HOOKS_DIR = 'hooks';

export type CreateWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
};

async function propagateDiptychState(projectDir: string, wtPath: string): Promise<void> {
  const baseConfig = join(projectDir, DIPTYCH_DIR, CONFIG_FILE);
  if (existsSync(baseConfig)) {
    ensureConfigGitignore(wtPath);
    await mkdir(join(wtPath, DIPTYCH_DIR), { recursive: true });
    await cp(baseConfig, join(wtPath, DIPTYCH_DIR, CONFIG_FILE));
  }
  const baseHooks = join(projectDir, DIPTYCH_DIR, HOOKS_DIR);
  if (existsSync(baseHooks)) {
    await cp(baseHooks, join(wtPath, DIPTYCH_DIR, HOOKS_DIR), { recursive: true });
  }
}

async function initWorktreeSubmodules(
  projectDir: string,
  wtPath: string,
  git: GitClient,
): Promise<void> {
  if (!existsSync(join(projectDir, '.gitmodules'))) return;
  await git.raw(['-C', wtPath, 'submodule', 'update', '--init', '--recursive']);
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const { projectDir, slug, git } = opts;
  const wtPath = resolveConfinedWorktreePath(projectDir, slug);
  const branch = `diptych/${slug}`;

  const status = await git.status();
  const gitignoreOnlyBookkeeping = await gitignoreDiffersOnlyByDiptychBookkeeping(projectDir);
  const dirtyFiles = status.files.filter((file) => {
    return !shouldIgnoreSourceDirtyPath(file.path, gitignoreOnlyBookkeeping);
  });
  if (dirtyFiles.length > 0) {
    throw worktreeError.sourceDirty(dirtyFiles.map((file) => file.path));
  }

  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    throw worktreeError.branchExists(branch);
  }

  await git.raw(['worktree', 'add', wtPath, '-b', branch]);
  await initWorktreeSubmodules(projectDir, wtPath, git);
  await propagateDiptychState(projectDir, wtPath);
  return wtPath;
}
