import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../core/paths.js';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { ensureConfigGitignore } from '../../core/config/load/io.js';
import type { GitClient } from '../../lib/git/client.js';
import { worktreeError } from './errors.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreSourceDirtyPath,
} from './cleanliness.js';
import { resolveConfinedWorktreePath } from './path.js';

const HOOKS_DIR = 'hooks';

export type CreateWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
};

async function propagateSplitbriefState(projectDir: string, wtPath: string): Promise<void> {
  const baseConfig = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  if (existsSync(baseConfig)) {
    ensureConfigGitignore(wtPath);
    await mkdir(join(wtPath, SPLITBRIEF_DIR), { recursive: true });
    await cp(baseConfig, join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE));
  }
  const baseHooks = join(projectDir, SPLITBRIEF_DIR, HOOKS_DIR);
  if (existsSync(baseHooks)) {
    await cp(baseHooks, join(wtPath, SPLITBRIEF_DIR, HOOKS_DIR), { recursive: true });
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
  const branch = `${SPLITBRIEF_IDENTITY.branchPrefix}${slug}`;

  const status = await git.status();
  const gitignoreOnlyBookkeeping = await gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir);
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
  await propagateSplitbriefState(projectDir, wtPath);
  return wtPath;
}
