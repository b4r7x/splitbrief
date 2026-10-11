import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCurrentChangedFiles } from '../lib/git/files.js';
import { readFileModeAtHead, showFileAtHead } from '../lib/git/refs.js';
import { isENOENT } from '../lib/process/errors.js';
import { computeDiff } from '../utils/diff.js';
import { collectTrackedFiles, hashFile } from './snapshots/files.js';

function hasGitMetadata(projectDir: string): boolean {
  return existsSync(join(projectDir, '.git'));
}

export type ChangeDetectorBaseline =
  | {
      kind: 'git-status';
      files: string[];
      /** What each file already changed at the start held then; null when it was absent. */
      contents: Record<string, Buffer | null>;
      modes: Record<string, number | null>;
    }
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

export async function captureChangeDetectorBaseline(
  projectDir: string,
  opts: { kind?: ChangeDetectionKind | undefined; ignoreProjectDir?: string | undefined } = {},
): Promise<ChangeDetectorBaseline> {
  const kind = opts.kind ?? (hasGitMetadata(projectDir) ? 'git-status' : 'file-hashes');
  if (kind === 'git-status') {
    const files = await getCurrentChangedFiles(projectDir);
    const [contents, modes] = await Promise.all([
      readContents(projectDir, files),
      Promise.all(files.map(async (file) => [file, await readMode(projectDir, file)] as const)),
    ]);
    return { kind: 'git-status', files, contents, modes: Object.fromEntries(modes) };
  }
  return {
    kind: 'file-hashes',
    hashes: await captureFileHashes(projectDir, opts),
    ignoreProjectDir: opts.ignoreProjectDir,
  };
}

async function readBytes(projectDir: string, file: string): Promise<Buffer | null> {
  try {
    return await readFile(join(projectDir, file));
  } catch {
    // Absent, a directory, or unreadable: there is no content to compare against.
    return null;
  }
}

async function readContents(
  projectDir: string,
  files: readonly string[],
): Promise<Record<string, Buffer | null>> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await readBytes(projectDir, file)] as const),
  );
  return Object.fromEntries(entries);
}

async function readMode(projectDir: string, file: string): Promise<number | null> {
  try {
    const stats = await lstat(join(projectDir, file));
    const permissions = stats.isFile() ? (stats.mode & 0o100 ? 0o755 : 0o644) : 0;
    return (stats.mode & 0o170000) | permissions;
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

export function orderChangedFiles(
  files: readonly string[],
  suggestedFiles: readonly string[],
): string[] {
  const remaining = new Set(files);
  const ordered = suggestedFiles.filter((file) => remaining.delete(file));
  return [...ordered, ...[...remaining].sort()];
}

export async function summarizeChanges(
  projectDir: string,
  before: ChangeDetectorBaseline,
  suggestedFiles: readonly string[] = [],
): Promise<{ files: string[]; linesAdded?: number; linesRemoved?: number }> {
  if (before.kind === 'file-hashes') {
    const after = await captureFileHashes(projectDir, {
      ignoreProjectDir: before.ignoreProjectDir,
    });
    const files = [...new Set([...Object.keys(before.hashes), ...Object.keys(after)])].filter(
      (file) => before.hashes[file] !== after[file],
    );
    return { files: orderChangedFiles(files, suggestedFiles) };
  }

  const candidates = new Set([...before.files, ...(await getCurrentChangedFiles(projectDir))]);
  const files: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const file of candidates) {
    const start = Object.hasOwn(before.contents, file)
      ? before.contents[file]
      : await showFileAtHead(projectDir, file);
    const now = await readBytes(projectDir, file);
    if (start === now || (now !== null && start?.equals(now))) {
      const startMode = Object.hasOwn(before.modes, file)
        ? before.modes[file]
        : start === null
          ? null
          : await readFileModeAtHead(projectDir, file);
      if (startMode === (await readMode(projectDir, file))) continue;
    }
    files.push(file);
    const counted = computeDiff(start?.toString('utf8') ?? '', now?.toString('utf8') ?? '');
    linesAdded += counted.linesAdded;
    linesRemoved += counted.linesRemoved;
  }
  return { files: orderChangedFiles(files, suggestedFiles), linesAdded, linesRemoved };
}

export function createChangeDetector(
  label: string,
): (projectDir: string, before: ChangeDetectorBaseline) => Promise<ChangeDetectionResult> {
  return async (projectDir: string, before: ChangeDetectorBaseline) => {
    const changes = await summarizeChanges(projectDir, before);
    if (changes.files.length === 0) {
      return {
        changed: false,
        output: `${label} exited without changing any files`,
        reason: 'no-files-changed',
      };
    }
    return { changed: true, output: '' };
  };
}
