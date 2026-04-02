import simpleGit, { type SimpleGit } from 'simple-git';

export const getGit = (dir: string): SimpleGit => (simpleGit as unknown as (dir: string) => SimpleGit)(dir);

export async function isGitRepo(dir: string): Promise<boolean> {
  const git = getGit(dir);
  return git.checkIsRepo();
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  const git = getGit(dir);
  await git.add('.');
  const result = await git.commit(message);
  return result.commit;
}

export async function getCurrentDiff(dir: string): Promise<string> {
  const git = getGit(dir);
  const [staged, unstaged] = await Promise.all([
    git.diff(['--cached']),
    git.diff(),
  ]);
  return staged + unstaged;
}

export async function hasExternalChanges(dir: string): Promise<boolean> {
  const git = getGit(dir);
  const status = await git.status();
  return status.modified.length > 0 || status.not_added.length > 0;
}

export async function discardTaskChanges(dir: string, taskFile: string, action: 'create' | 'modify'): Promise<void> {
  const git = getGit(dir);
  if (action === 'modify') {
    await git.checkout(['--', taskFile]);
  } else {
    await git.clean('f', ['--', taskFile]);
  }
}
