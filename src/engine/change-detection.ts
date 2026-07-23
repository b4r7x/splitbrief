import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentChangedFiles } from '../lib/git/files.js';
import { collectTrackedFiles, hashFile } from './snapshots/files.js';

function hasGitMetadata(projectDir: string): boolean {
  return existsSync(join(projectDir, '.git'));
}

export type ChangeDetectorBaseline =
  | { kind: 'git-status'; files: string[] }
  | {
      kind: 'file-hashes';
      hashes: Record<string, string | null>;
      ignoreProjectDir?: string | undefined;
    };

export type ChangeDetector = (
  projectDir: string,
  before: ChangeDetectorBaseline,
) => Promise<{ changed: boolean; output: string }>;

const HASH_CONCURRENCY = 16;

export async function hashFiles(
  projectDir: string,
  files: string[],
): Promise<Record<string, string | null>> {
  const entries: Record<string, string | null> = {};
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (file === undefined) return;
      entries[file] = await hashFile(join(projectDir, file));
    }
  }
  const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker);
  await Promise.all(workers);
  return entries;
}

async function captureFileHashes(
  projectDir: string,
  opts: { ignoreProjectDir?: string | undefined } = {},
): Promise<Record<string, string | null>> {
  return hashFiles(projectDir, await collectTrackedFiles(projectDir, opts));
}

function hasHashChanges(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): boolean {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const file of files) {
    if (before[file] !== after[file]) return true;
  }
  return false;
}

export async function captureChangeDetectorBaseline(
  projectDir: string,
  opts: { ignoreProjectDir?: string | undefined } = {},
): Promise<ChangeDetectorBaseline> {
  if (hasGitMetadata(projectDir)) {
    return { kind: 'git-status', files: await getCurrentChangedFiles(projectDir) };
  }
  return {
    kind: 'file-hashes',
    hashes: await captureFileHashes(projectDir, opts),
    ignoreProjectDir: opts.ignoreProjectDir,
  };
}

export function createChangeDetector(label: string) {
  return async (projectDir: string, before: ChangeDetectorBaseline) => {
    let changed = false;
    if (before.kind === 'git-status') {
      const changedFiles = await getCurrentChangedFiles(projectDir);
      const beforeSet = new Set(before.files);
      changed = changedFiles.some((file) => !beforeSet.has(file));
    } else {
      changed = hasHashChanges(
        before.hashes,
        await captureFileHashes(projectDir, { ignoreProjectDir: before.ignoreProjectDir }),
      );
    }

    if (!changed) {
      return { changed: false, output: `${label} exited without changing any files` };
    }
    return { changed: true, output: '' };
  };
}
