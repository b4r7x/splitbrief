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

export type ChangeDetectionKind = ChangeDetectorBaseline['kind'];

export type ChangeDetectionResult =
  | { changed: true; output: '' }
  | { changed: false; output: string; reason: 'no-files-changed' };

export type ChangeDetector = (
  projectDir: string,
  before: ChangeDetectorBaseline,
) => Promise<ChangeDetectionResult>;

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

// A caller that knows what it handed the runner says so: a linked git worktree
// carries a `.git` file but its status is seeded with the source's dirty files,
// and the git-status comparator only sees paths that were not already in it.
// Only a caller with no such knowledge falls back to sniffing the directory.
export async function captureChangeDetectorBaseline(
  projectDir: string,
  opts: { kind?: ChangeDetectionKind | undefined; ignoreProjectDir?: string | undefined } = {},
): Promise<ChangeDetectorBaseline> {
  const kind = opts.kind ?? (hasGitMetadata(projectDir) ? 'git-status' : 'file-hashes');
  if (kind === 'git-status') {
    return { kind: 'git-status', files: await getCurrentChangedFiles(projectDir) };
  }
  return {
    kind: 'file-hashes',
    hashes: await captureFileHashes(projectDir, opts),
    ignoreProjectDir: opts.ignoreProjectDir,
  };
}

export function createChangeDetector(
  label: string,
): (projectDir: string, before: ChangeDetectorBaseline) => Promise<ChangeDetectionResult> {
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
      return {
        changed: false,
        output: `${label} exited without changing any files`,
        reason: 'no-files-changed',
      };
    }
    return { changed: true, output: '' };
  };
}
