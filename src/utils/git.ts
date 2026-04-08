import { simpleGit, type SimpleGit } from 'simple-git';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

function getStatusPaths(status: Awaited<ReturnType<SimpleGit['status']>>): string[] {
  return status.files.map((file) => file.path);
}

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

export async function createCheckpoint(dir: string, label: string): Promise<string> {
  const git = getGit(dir);
  await git.add('.');
  const stashSha = (await git.raw(['stash', 'create', `tiny-spec checkpoint: ${label}`])).trim();
  if (!stashSha) return '';
  const tagName = `tiny-spec/${label}`;
  await git.tag([tagName, stashSha]);
  await git.reset();
  return tagName;
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
  return getStatusPaths(status).length > 0;
}

export async function getChangedFiles(dir: string): Promise<string[]> {
  const git = getGit(dir);
  const status = await git.status();
  return getStatusPaths(status);
}

export async function discardTaskChanges(dir: string, taskFile: string, action: 'create' | 'modify'): Promise<void> {
  const git = getGit(dir);
  if (action === 'modify') {
    await git.checkout(['--', taskFile]);
  } else {
    await git.clean('f', ['--', taskFile]);
  }
}
