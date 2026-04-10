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

