import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getGitForDir } from './client.js';

export type InProgressGitOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export async function isGitRepo(dir: string): Promise<boolean> {
  const git = getGitForDir(dir);
  return git.checkIsRepo();
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await getGitForDir(dir).raw(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

// Resolves to the repository's shared git directory: `<repo>/.git` from the
// main checkout and from every linked worktree alike, where `<dir>/.git` is a
// file pointing into it rather than a directory. Canonical, so two spellings of
// the same checkout — a symlinked parent, a `/var` vs `/private/var` tmpdir —
// name one directory rather than two.
export async function getGitCommonDir(dir: string): Promise<string> {
  const raw = (await getGitForDir(dir).raw(['rev-parse', '--git-common-dir'])).trim();
  return realpath(isAbsolute(raw) ? raw : join(dir, raw));
}

export async function getRepoToplevel(dir: string): Promise<string | null> {
  try {
    const top = (await getGitForDir(dir).revparse(['--show-toplevel'])).trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

export async function hasCommitterIdentity(dir: string): Promise<boolean> {
  try {
    const ident = (await getGitForDir(dir).raw(['var', 'GIT_COMMITTER_IDENT'])).trim();
    return ident.length > 0;
  } catch {
    return false;
  }
}

export async function getInProgressGitOp(dir: string): Promise<InProgressGitOp | null> {
  let gitDir: string;
  try {
    gitDir = (await getGitForDir(dir).revparse(['--git-dir'])).trim();
  } catch {
    return null;
  }
  if (gitDir.length === 0) return null;
  const resolved = isAbsolute(gitDir) ? gitDir : join(dir, gitDir);

  if (existsSync(join(resolved, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(resolved, 'rebase-merge')) || existsSync(join(resolved, 'rebase-apply'))) {
    return 'rebase';
  }
  if (existsSync(join(resolved, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(resolved, 'REVERT_HEAD'))) return 'revert';
  if (existsSync(join(resolved, 'BISECT_LOG'))) return 'bisect';
  return null;
}
