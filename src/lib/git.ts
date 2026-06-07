import { spawn } from 'node:child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { error } from '../utils/error.js';
import { toErrorMessage } from '../utils/format-errors.js';

const getGit = (dir: string): SimpleGit => simpleGit(dir);

export type GitClient = SimpleGit;

export function createGitClient(dir: string): GitClient {
  return getGit(dir);
}

export const gitError = {
  commandFailed: (intent: string, causeMessage: string, cause?: unknown) =>
    error(
      'git-command-failed',
      `git ${intent} failed: ${causeMessage}`,
      { intent, causeMessage },
      cause,
    ),
  branchNameCollision: (desiredName: string) =>
    error('git-branch-name-collision', `too many branch name collisions on ${desiredName}`, {
      desiredName,
    }),
} as const;

export type GitCommandError = ReturnType<typeof gitError.commandFailed>;

function toGitCommandError(intent: string, err: unknown): GitCommandError {
  return gitError.commandFailed(intent, toErrorMessage(err), err);
}

async function runGit<T>(intent: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toGitCommandError(intent, err);
  }
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
  return runGit('status', () => getGit(dir).status());
}

export async function stageAll(dir: string): Promise<void> {
  await runGit('add .', () => getGit(dir).add('.'));
}

export async function resetIndex(dir: string): Promise<void> {
  await runGit('reset', () => getGit(dir).reset(['--mixed', 'HEAD']));
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  return runGit('commit', async () => (await getGit(dir).commit(message)).commit);
}

export async function getCurrentDiff(dir: string): Promise<string> {
  return runGit('diff', async () => {
    const git = getGit(dir);
    const [staged, unstaged] = await Promise.all([git.diff(['--cached']), git.diff()]);
    return [staged, unstaged].filter(Boolean).join('\n');
  });
}

export async function getCurrentCommitSha(dir: string): Promise<string> {
  return runGit('rev-parse HEAD', async () => {
    const sha = (await getGit(dir).raw(['rev-parse', 'HEAD'])).trim();
    return sha.length > 0 ? sha : 'HEAD';
  });
}

export async function getCurrentBranch(dir: string): Promise<string> {
  return runGit('rev-parse --abbrev-ref HEAD', async () =>
    (await getGit(dir).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
  );
}

export async function getCurrentChangedFiles(dir: string): Promise<string[]> {
  return runGit('status --porcelain', async () => getStatusPaths(await getGit(dir).status()));
}

export async function getCommittedFilesSince(dir: string, baseRef: string): Promise<string[]> {
  return runGit(`diff --name-only ${baseRef} HEAD`, async () =>
    parseNameOnly(await getGit(dir).diff(['--name-only', baseRef, 'HEAD'])),
  );
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

export async function createTaggedStash(
  dir: string,
  message: string,
  tagName: string,
): Promise<string> {
  await stageAll(dir);
  try {
    return await runGit('stash create', async () => {
      const git = getGit(dir);
      const stashSha = (await git.raw(['stash', 'create', message])).trim();
      if (!stashSha) {
        await resetIndex(dir);
        return '';
      }
      try {
        await git.tag([tagName, stashSha]);
      } catch (err) {
        await resetIndex(dir);
        throw err;
      }
      await git.reset();
      return tagName;
    });
  } catch (err) {
    try {
      await resetIndex(dir);
    } catch {
      // best-effort restore after a failed checkpoint
    }
    throw err;
  }
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  return runGit('branch --list', async () => {
    const result = await getGit(dir).branch(['--list', name]);
    return result.all.includes(name);
  });
}

/**
 * Create a local branch named `desiredName`. If that name already exists,
 * appends a numeric suffix (-2, -3, …) until a free name is found (up to -99).
 * Returns the actual branch name created.
 */
export async function createBranch(dir: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 2;
  while (await branchExists(dir, name)) {
    if (suffix > 99) {
      throw gitError.branchNameCollision(desiredName);
    }
    name = `${desiredName}-${suffix}`;
    suffix++;
  }
  await runGit('checkout -b', () => getGit(dir).checkoutLocalBranch(name));
  return name;
}

export async function discardFileChange(
  dir: string,
  file: string,
  mode: 'tracked' | 'untracked',
): Promise<void> {
  await runGit(`discard ${file}`, async () => {
    const git = getGit(dir);
    if (mode === 'tracked') {
      await git.checkout(['--', file]);
    } else {
      await git.clean('f', ['--', file]);
    }
  });
}

async function isTracked(dir: string, file: string): Promise<boolean> {
  // Intentional boolean detection: a non-zero exit from ls-files means the
  // path is untracked, not an error to surface — so this catch is not swallowing.
  try {
    await getGit(dir).raw(['ls-files', '--error-unmatch', '--', file]);
    return true;
  } catch {
    return false;
  }
}

export async function discardChangedFiles(dir: string, files: string[]): Promise<void> {
  for (const file of files) {
    await discardFileChange(dir, file, (await isTracked(dir, file)) ? 'tracked' : 'untracked');
  }
}
