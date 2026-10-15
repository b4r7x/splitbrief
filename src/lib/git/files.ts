import { spawnPipe } from '../process/spawn/lifecycle.js';
import type { GitClient } from './client.js';
import { getGitForDir, gitBinary, parseNulSeparated, runGit } from './client.js';

const GITLINK_MODE = '160000';

function getStatusPaths(status: Awaited<ReturnType<GitClient['status']>>): string[] {
  return [
    ...new Set(status.files.flatMap((file) => (file.from ? [file.from, file.path] : [file.path]))),
  ];
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

/** Ignored untracked paths; a wholly ignored directory is one `dir/` entry. */
export async function listIgnoredPaths(dir: string): Promise<string[]> {
  try {
    return parseNulSeparated(
      await getGitForDir(dir).raw([
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ]),
    );
  } catch {
    return [];
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

export async function checkIgnoredPaths(dir: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const chunks: string[] = [];
  try {
    return await spawnPipe({
      command: gitBinary(),
      args: ['check-ignore', '--stdin', '-z'],
      cwd: dir,
      detached: true,
      ledger: false,
      stdin: paths.join('\0'),
      onStdout: (chunk) => {
        chunks.push(chunk);
      },
      onStderr: () => undefined,
      onClose: (code) => {
        if (code !== 0 && code !== 1) return [];
        return parseNulSeparated(chunks.join(''));
      },
    });
  } catch {
    return [];
  }
}
