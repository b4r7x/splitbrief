import { spawn } from 'node:child_process';
import { getGitForDir, parseNulSeparated, runGit } from './client.js';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function diffUntrackedFile(dir: string, file: string): Promise<string> {
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
    const git = getGitForDir(dir);
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
    const git = getGitForDir(dir);
    const [tracked, status] = await Promise.all([git.diff([baseRef]), git.status()]);
    const untracked = await collectUntrackedDiffs(dir, status.not_added, excludeUntracked);
    return [tracked, ...untracked].filter(Boolean).join('\n');
  });
}

export async function getCommittedFilesSince(dir: string, baseRef: string): Promise<string[]> {
  return runGit(`diff --name-only -z ${baseRef} HEAD`, async () =>
    parseNulSeparated(await getGitForDir(dir).diff(['--name-only', '-z', baseRef, 'HEAD'])),
  );
}
