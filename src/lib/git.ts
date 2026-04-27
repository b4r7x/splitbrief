import { simpleGit, type SimpleGit } from 'simple-git';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

export type GitCommandError = Error & { readonly intent: string; readonly causeMessage: string };

export function createGitCommandError(intent: string, causeMessage: string): GitCommandError {
  const err = new Error(`git ${intent} failed: ${causeMessage}`) as GitCommandError;
  (err as { intent: string }).intent = intent;
  (err as { causeMessage: string }).causeMessage = causeMessage;
  return err;
}

export function isGitCommandError(err: unknown): err is GitCommandError {
  return (
    err instanceof Error &&
    typeof (err as unknown as Record<string, unknown>)['intent'] === 'string' &&
    typeof (err as unknown as Record<string, unknown>)['causeMessage'] === 'string'
  );
}

function toGitCommandError(intent: string, err: unknown): GitCommandError {
  return createGitCommandError(intent, err instanceof Error ? err.message : String(err));
}

function getStatusPaths(status: Awaited<ReturnType<SimpleGit['status']>>): string[] {
  return status.files.map((file) => file.path);
}

function parseNameOnly(output: string): string[] {
  if (output.trim().length === 0) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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

export async function getCurrentCommitSha(dir: string): Promise<string> {
  try {
    const out = await getGit(dir).raw(['rev-parse', 'HEAD']);
    const sha = out.trim();
    return sha.length > 0 ? sha : 'HEAD';
  } catch (err) {
    throw toGitCommandError('rev-parse HEAD', err);
  }
}

export async function getCurrentChangedFiles(dir: string): Promise<string[]> {
  try {
    return getStatusPaths(await getGit(dir).status());
  } catch (err) {
    throw toGitCommandError('status --porcelain', err);
  }
}

export async function getCommittedFilesSince(dir: string, baseRef: string): Promise<string[]> {
  try {
    return parseNameOnly(await getGit(dir).diff(['--name-only', baseRef, 'HEAD']));
  } catch (err) {
    throw toGitCommandError(`diff --name-only ${baseRef} HEAD`, err);
  }
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

async function isTracked(dir: string, file: string): Promise<boolean> {
  try {
    await getGit(dir).raw(['ls-files', '--error-unmatch', '--', file]);
    return true;
  } catch {
    return false;
  }
}

export async function discardChangedFiles(dir: string, files: string[]): Promise<void> {
  const git = getGit(dir);
  for (const file of files) {
    if (await isTracked(dir, file)) {
      await git.checkout(['--', file]);
    } else {
      await git.clean('f', ['--', file]);
    }
  }
}
