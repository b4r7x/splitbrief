import { simpleGit, type SimpleGit } from 'simple-git';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

function getStatusPaths(status: Awaited<ReturnType<SimpleGit['status']>>): string[] {
  return status.files.map((file) => file.path);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const git = getGit(dir);
  return git.checkIsRepo();
}

export async function stageAll(dir: string): Promise<void> {
  await getGit(dir).add('.');
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  const git = getGit(dir);
  const result = await git.commit(message);
  return result.commit;
}

export async function getCurrentDiff(dir: string): Promise<string> {
  const git = getGit(dir);
  const [staged, unstaged] = await Promise.all([
    git.diff(['--cached']),
    git.diff(),
  ]);
  return [staged, unstaged].filter(Boolean).join('\n');
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

export async function createCheckpoint(dir: string, label: string): Promise<string> {
  await stageAll(dir);
  const git = getGit(dir);
  const stashSha = (await git.raw(['stash', 'create', `diptych checkpoint: ${label}`])).trim();
  if (!stashSha) return '';
  const tagName = `diptych/${label}`;
  await git.tag([tagName, stashSha]);
  await git.reset();
  return tagName;
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  const git = getGit(dir);
  const result = await git.branch(['--list', name]);
  return result.all.includes(name);
}

/**
 * Create a local branch named `desiredName`. If that name already exists,
 * appends a numeric suffix (-2, -3, …) until a free name is found (up to -99).
 * Returns the actual branch name created.
 */
export async function createBranch(dir: string, desiredName: string): Promise<string> {
  const git = getGit(dir);
  let name = desiredName;
  let suffix = 2;
  while (await branchExists(dir, name)) {
    if (suffix > 99) {
      throw new Error(`too many branch name collisions on ${desiredName}`);
    }
    name = `${desiredName}-${suffix}`;
    suffix++;
  }
  await git.checkoutLocalBranch(name);
  return name;
}

export async function discardTaskChanges(
  dir: string,
  taskFile: string,
  action: 'create' | 'modify',
): Promise<void> {
  const git = getGit(dir);
  if (action === 'modify') {
    await git.checkout(['--', taskFile]);
  } else {
    await git.clean('f', ['--', taskFile]);
  }
}
