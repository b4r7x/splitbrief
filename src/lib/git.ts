import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

function parseNulSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const git = getGit(dir);
  return git.checkIsRepo();
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await getGit(dir).raw(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoToplevel(dir: string): Promise<string | null> {
  try {
    const top = (await getGit(dir).revparse(['--show-toplevel'])).trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

export async function hasCommitterIdentity(dir: string): Promise<boolean> {
  try {
    const ident = (await getGit(dir).raw(['var', 'GIT_COMMITTER_IDENT'])).trim();
    return ident.length > 0;
  } catch {
    return false;
  }
}

export type InProgressGitOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export async function getInProgressGitOp(dir: string): Promise<InProgressGitOp | null> {
  let gitDir: string;
  try {
    gitDir = (await getGit(dir).revparse(['--git-dir'])).trim();
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

export async function getGitStatus(dir: string): Promise<{
  files: Array<{ path: string }>;
  not_added: string[];
}> {
  return runGit('status', () => getGit(dir).status());
}

export async function stageAll(dir: string): Promise<void> {
  await runGit('add .', () => getGit(dir).add('.'));
}

export async function stageFiles(dir: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await runGit('add --', () => getGit(dir).add(['--', ...files]));
}

export async function resetIndex(dir: string): Promise<void> {
  await runGit('reset', () => getGit(dir).reset(['--mixed', 'HEAD']));
}

export async function getStagedFiles(dir: string): Promise<string[]> {
  return runGit('diff --cached --name-only -z', async () =>
    parseNulSeparated(await getGit(dir).diff(['--cached', '--name-only', '-z'])),
  );
}

export async function resetIndexPreservingStaged(
  dir: string,
  stagedBefore: string[],
): Promise<void> {
  await resetIndex(dir);
  await stageFiles(dir, stagedBefore);
}

export async function commitChanges(dir: string, message: string): Promise<string> {
  return runGit('commit', async () => (await getGit(dir).commit(message)).commit);
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function diffUntrackedFile(dir: string, file: string): Promise<string> {
  // `git diff --no-index` exits 1 when the inputs differ; for an untracked file
  // that non-zero exit IS the diff, not a failure (exit 2 is a real error).
  return new Promise<string>((resolve) => {
    const child = spawn('git', ['diff', '--no-color', '--no-index', '--', NULL_DEVICE, file], {
      cwd: dir,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', (code: number | null) => {
      resolve(code === 0 || code === 1 ? Buffer.concat(chunks).toString('utf8') : '');
    });
  });
}

async function collectUntrackedDiffs(
  dir: string,
  notAdded: string[],
  excludeUntracked?: (file: string) => boolean,
): Promise<string[]> {
  const untrackedFiles = excludeUntracked
    ? notAdded.filter((file) => !excludeUntracked(file))
    : notAdded;
  return Promise.all(untrackedFiles.map((file) => diffUntrackedFile(dir, file)));
}

export async function getCurrentDiff(
  dir: string,
  excludeUntracked?: (file: string) => boolean,
): Promise<string> {
  return runGit('diff', async () => {
    const git = getGit(dir);
    const [staged, unstaged, status] = await Promise.all([
      git.diff(['--cached', '--no-color']),
      git.diff(['--no-color']),
      git.status(),
    ]);
    const untracked = await collectUntrackedDiffs(dir, status.not_added, excludeUntracked);
    return [staged, unstaged, ...untracked].filter(Boolean).join('\n');
  });
}

export async function getDiffSince(
  dir: string,
  baseRef: string,
  excludeUntracked?: (file: string) => boolean,
): Promise<string> {
  return runGit(`diff ${baseRef}`, async () => {
    const git = getGit(dir);
    const [tracked, status] = await Promise.all([git.diff([baseRef]), git.status()]);
    const untracked = await collectUntrackedDiffs(dir, status.not_added, excludeUntracked);
    return [tracked, ...untracked].filter(Boolean).join('\n');
  });
}

export async function getRunStartHead(
  dir: string,
  runCommitMessagePrefix: string,
): Promise<string | null> {
  try {
    const log = await getGit(dir).raw(['log', '--format=%H%x00%s', 'HEAD']);
    for (const line of log.split('\n')) {
      const sep = line.indexOf('\0');
      if (sep === -1) continue;
      const sha = line.slice(0, sep);
      const subject = line.slice(sep + 1);
      if (!subject.startsWith(runCommitMessagePrefix)) return sha;
    }
    return null;
  } catch {
    return null;
  }
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

export async function listTrackedAndUntrackedFiles(dir: string): Promise<string[] | null> {
  try {
    const output = await getGit(dir).raw([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    return parseNulSeparated(output);
  } catch {
    return null;
  }
}

const GITLINK_MODE = '160000';

export async function listGitlinkPaths(dir: string): Promise<string[]> {
  try {
    const output = await getGit(dir).raw(['ls-files', '--stage', '-z']);
    const gitlinks: string[] = [];
    for (const entry of parseNulSeparated(output)) {
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const mode = entry.slice(0, entry.indexOf(' '));
      if (mode === GITLINK_MODE) gitlinks.push(entry.slice(tab + 1));
    }
    return gitlinks;
  } catch {
    return [];
  }
}

export async function discardSubmoduleChange(dir: string, submodule: string): Promise<void> {
  await runGit(`submodule update ${submodule}`, () =>
    getGit(dir).raw(['submodule', 'update', '--init', '--recursive', '--', submodule]),
  );
}

export async function getCommittedFilesSince(dir: string, baseRef: string): Promise<string[]> {
  return runGit(`diff --name-only -z ${baseRef} HEAD`, async () =>
    parseNulSeparated(await getGit(dir).diff(['--name-only', '-z', baseRef, 'HEAD'])),
  );
}

export async function showFileAtHead(dir: string, file: string): Promise<string | null> {
  try {
    return await getGit(dir).show([`HEAD:${file}`]);
  } catch {
    return null;
  }
}

export async function showFileAtRef(
  dir: string,
  ref: string,
  file: string,
): Promise<string | null> {
  try {
    return await getGit(dir).show([`${ref}:${file}`]);
  } catch {
    return null;
  }
}

export async function restoreFileFromRef(dir: string, ref: string, file: string): Promise<void> {
  await runGit(`checkout ${ref} -- ${file}`, () => getGit(dir).checkout([ref, '--', file]));
}

export async function resetIndexEntryToRef(dir: string, ref: string, file: string): Promise<void> {
  await runGit(`reset ${ref} -- ${file}`, () => getGit(dir).reset([ref, '--', file]));
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
  const stagedBefore = await getStagedFiles(dir);
  await stageAll(dir);
  try {
    return await runGit('stash create', async () => {
      const git = getGit(dir);
      const stashSha = (await git.raw(['stash', 'create', message])).trim();
      if (!stashSha) {
        await resetIndexPreservingStaged(dir, stagedBefore);
        return '';
      }
      try {
        await git.tag([tagName, stashSha]);
      } catch (err) {
        await resetIndexPreservingStaged(dir, stagedBefore);
        throw err;
      }
      await resetIndexPreservingStaged(dir, stagedBefore);
      return tagName;
    });
  } catch (err) {
    try {
      await resetIndexPreservingStaged(dir, stagedBefore);
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
    } else if (file.endsWith('/')) {
      // A porcelain directory entry (e.g. an untracked embedded git repo) is not
      // recursed into by `git clean -f`, which exits 0 without removing it. The
      // second force (`-ff`) plus `-d` is required to recurse into nested
      // directories and remove embedded repositories.
      await git.raw(['clean', '-ff', '-d', '--', file]);
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
