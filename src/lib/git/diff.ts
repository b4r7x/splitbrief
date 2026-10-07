import { spawn } from 'node:child_process';
import { getGitForDir, gitBinary, gitError, parseNulSeparated, runGit } from './client.js';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function diffUntrackedFile(dir: string, file: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn(
      gitBinary(),
      ['diff', '--no-color', '--no-index', '--', NULL_DEVICE, file],
      {
        cwd: dir,
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(''));
    child.on('close', (code: number | null) => {
      resolve(code === 0 || code === 1 ? Buffer.concat(chunks).toString('utf8') : '');
    });
  });
}

const UNTRACKED_DIFF_CONCURRENCY = 8;

// Each untracked file is one `git diff --no-index` launch; a fixed pool keeps a
// working tree with many new files from forking them all at once. Results keep
// the input order, so the joined diff reads the same as a serial walk.
async function collectUntrackedDiffs(dir: string, untracked: readonly string[]): Promise<string[]> {
  const diffs = new Array<string>(untracked.length).fill('');
  let next = 0;
  async function worker(): Promise<void> {
    for (let index = next++; index < untracked.length; index = next++) {
      const file = untracked[index];
      if (file !== undefined) diffs[index] = await diffUntrackedFile(dir, file);
    }
  }
  const workers = Math.min(UNTRACKED_DIFF_CONCURRENCY, untracked.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return diffs;
}

/** `untracked`: the untracked files to include, from the caller's one `git status`. */
export async function getCurrentDiff(dir: string, untracked: readonly string[]): Promise<string> {
  return runGit('diff', async () => {
    const git = getGitForDir(dir);
    const [staged, unstaged] = await Promise.all([
      git.diff(['--cached', '--no-color']),
      git.diff(['--no-color']),
    ]);
    const untrackedDiffs = await collectUntrackedDiffs(dir, untracked);
    return [staged, unstaged, ...untrackedDiffs].filter(Boolean).join('\n');
  });
}

/** `untracked`: the untracked files to include, from the caller's one `git status`. */
export async function getDiffSince(
  dir: string,
  baseRef: string,
  untracked: readonly string[],
): Promise<string> {
  // The ref is a positional argument of `git diff`, where a leading `-` is read as
  // an option instead — `--output=<file>` would write the diff anywhere on disk.
  // No ref can start with `-`, so refuse the shape before git sees it.
  if (baseRef.startsWith('-')) {
    throw gitError.commandFailed(`diff ${baseRef}`, "a git ref cannot start with '-'");
  }
  return runGit(`diff ${baseRef}`, async () => {
    const tracked = await getGitForDir(dir).diff([baseRef, '--']);
    const untrackedDiffs = await collectUntrackedDiffs(dir, untracked);
    return [tracked, ...untrackedDiffs].filter(Boolean).join('\n');
  });
}

export async function getCommittedFilesSince(dir: string, baseRef: string): Promise<string[]> {
  return runGit(`diff --name-only -z ${baseRef} HEAD`, async () =>
    parseNulSeparated(await getGitForDir(dir).diff(['--name-only', '-z', baseRef, 'HEAD'])),
  );
}
