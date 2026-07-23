import { spawn } from 'node:child_process';
import type { GitClient } from './client.js';
import { getGitForDir, parseNulSeparated, runGit } from './client.js';

const GITLINK_MODE = '160000';

function getStatusPaths(status: Awaited<ReturnType<GitClient['status']>>): string[] {
  return status.files.map((file) => file.path);
}

export async function getGitStatus(dir: string): Promise<{
  files: Array<{ path: string }>;
  not_added: string[];
}> {
  return runGit('status', () => getGitForDir(dir).status());
}

export async function getCurrentChangedFiles(dir: string): Promise<string[]> {
  return runGit('status --porcelain', async () => getStatusPaths(await getGitForDir(dir).status()));
}

export async function listTrackedAndUntrackedFiles(dir: string): Promise<string[] | null> {
  try {
    const output = await getGitForDir(dir).raw([
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

export async function listGitlinkPaths(dir: string): Promise<string[]> {
  try {
    const output = await getGitForDir(dir).raw(['ls-files', '--stage', '-z']);
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
    getGitForDir(dir).raw(['submodule', 'update', '--init', '--recursive', '--', submodule]),
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

export async function discardFileChange(
  dir: string,
  file: string,
  mode: 'tracked' | 'untracked',
): Promise<void> {
  await runGit(`discard ${file}`, async () => {
    const git = getGitForDir(dir);
    if (mode === 'tracked') {
      await git.checkout(['--', file]);
    } else if (file.endsWith('/')) {
      await git.raw(['clean', '-ff', '-d', '--', file]);
    } else {
      await git.clean('f', ['--', file]);
    }
  });
}

async function isTracked(dir: string, file: string): Promise<boolean> {
  try {
    await getGitForDir(dir).raw(['ls-files', '--error-unmatch', '--', file]);
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
