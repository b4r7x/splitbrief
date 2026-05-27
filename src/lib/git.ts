import { spawn } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { error, matches } from '../utils/error.js';
import { toErrorMessage } from '../utils/format-errors.js';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

export type GitClient = SimpleGit;

export function createGitClient(dir: string): GitClient {
  return getGit(dir);
}

export const gitError = {
  commandFailed: (intent: string, causeMessage: string, cause?: unknown) =>
    error('git-command-failed', `git ${intent} failed: ${causeMessage}`, { intent, causeMessage }, cause),
  branchNameCollision: (desiredName: string) =>
    error('git-branch-name-collision', `too many branch name collisions on ${desiredName}`, { desiredName }),
  isCommandFailed: matches('git-command-failed'),
} as const;

export type GitCommandError = ReturnType<typeof gitError.commandFailed>;

function toGitCommandError(intent: string, err: unknown): GitCommandError {
  return gitError.commandFailed(intent, toErrorMessage(err), err);
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

export async function getGitStatus(dir: string): Promise<{
  files: Array<{ path: string }>;
  not_added: string[];
}> {
  try {
    return await getGit(dir).status();
  } catch (err) {
    throw toGitCommandError('status', err);
  }
}

export async function stageAll(dir: string): Promise<void> {
  try {
    await getGit(dir).add('.');
  } catch (err) {
    throw toGitCommandError('add .', err);
  }
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  try {
    const git = getGit(dir);
    const result = await git.commit(message);
    return result.commit;
  } catch (err) {
    throw toGitCommandError('commit', err);
  }
}

export async function getCurrentDiff(dir: string): Promise<string> {
  const git = getGit(dir);
  const [staged, unstaged] = await Promise.all([
    git.diff(['--cached']),
    git.diff(),
  ]);
  return [staged, unstaged].filter(Boolean).join('\n');
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

export async function checkIgnoredPaths(dir: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  return new Promise<string[]>((resolve) => {
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd: dir });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve([]));
    child.on('close', (code: number | null) => {
      if (code !== 0 && code !== 1) {
        resolve([]);
        return;
      }
      const output = Buffer.concat(chunks).toString('utf8');
      const ignored = output.split('\0').filter(Boolean);
      resolve(ignored);
    });
    child.stdin.end(paths.join('\0'));
  });
}

export async function createTaggedStash(dir: string, message: string, tagName: string): Promise<string> {
  await stageAll(dir);
  const git = getGit(dir);
  const stashSha = (await git.raw(['stash', 'create', message])).trim();
  if (!stashSha) return '';
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
      throw gitError.branchNameCollision(desiredName);
    }
    name = `${desiredName}-${suffix}`;
    suffix++;
  }
  await git.checkoutLocalBranch(name);
  return name;
}

export async function discardFileChange(
  dir: string,
  file: string,
  mode: 'tracked' | 'untracked',
): Promise<void> {
  const git = getGit(dir);
  if (mode === 'tracked') {
    await git.checkout(['--', file]);
  } else {
    await git.clean('f', ['--', file]);
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
