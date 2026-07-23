import { getCommittedFilesSince } from '../../lib/git/diff.js';
import { getCurrentChangedFiles } from '../../lib/git/files.js';
import { getCurrentCommitSha } from '../../lib/git/refs.js';
import { hasCommits } from '../../lib/git/repository.js';
import { isInternalGitStatusPath } from '../../core/paths.js';
import { confinedExists, confinedReadFileAsync } from '../../lib/confined-fs.js';
import { assertPathConfined } from '../../lib/path-confinement.js';
import { sha256Hex } from '../../utils/sha256.js';
import { matchesActionPattern } from './approval/action-classifier.js';
import type { ChangedFilesSnapshot } from './approval/file-snapshots/types.js';
import type { Task } from '../../core/schemas/task.js';
import type { PersistedChangedFilesBaseline } from '../../core/schemas/workflow.js';

export type ChangedFilesBaseline = {
  head: string | null;
  fingerprints: Map<string, string>;
  activeTaskSnapshot?: ChangedFilesSnapshot | undefined;
};

export function serializeChangedFilesBaseline(
  baseline: ChangedFilesBaseline,
): PersistedChangedFilesBaseline {
  return {
    head: baseline.head,
    fingerprints: Object.fromEntries(baseline.fingerprints),
    ...(baseline.activeTaskSnapshot !== undefined && {
      activeTaskSnapshot: baseline.activeTaskSnapshot,
    }),
  };
}

export function deserializeChangedFilesBaseline(
  persisted: PersistedChangedFilesBaseline,
): ChangedFilesBaseline {
  return {
    head: persisted.head,
    fingerprints: new Map(Object.entries(persisted.fingerprints)),
    activeTaskSnapshot: persisted.activeTaskSnapshot,
  };
}

export function withActiveTaskSnapshot(
  baseline: ChangedFilesBaseline,
  activeTaskSnapshot: ChangedFilesSnapshot,
): ChangedFilesBaseline {
  return { ...baseline, activeTaskSnapshot };
}

function isInternalDiptychArtifact(file: string): boolean {
  return isInternalGitStatusPath(file);
}

export function userVisibleChangedFiles(files: string[]): string[] {
  return files.filter((file) => !isInternalDiptychArtifact(file));
}

async function captureHead(projectDir: string): Promise<string | null> {
  return (await hasCommits(projectDir)) ? getCurrentCommitSha(projectDir) : null;
}

async function candidateChangedFiles(projectDir: string, head: string | null): Promise<string[]> {
  const working = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  const committed =
    head === null ? [] : userVisibleChangedFiles(await getCommittedFilesSince(projectDir, head));
  return [...new Set([...working, ...committed])];
}

async function fingerprintChangedFile(projectDir: string, file: string): Promise<string> {
  try {
    assertPathConfined(file, projectDir);
    if (!confinedExists(projectDir, file)) return 'missing';
    const content = await confinedReadFileAsync(projectDir, file);
    if (content === null) return 'missing';
    return sha256Hex(content);
  } catch {
    return 'missing';
  }
}

async function fingerprintFiles(projectDir: string, files: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await fingerprintChangedFile(projectDir, file)] as const),
  );
  return new Map(entries);
}

export async function captureChangedFilesBaseline(
  projectDir: string,
  files?: string[],
): Promise<ChangedFilesBaseline> {
  const head = await captureHead(projectDir);
  const changedFiles =
    files !== undefined
      ? userVisibleChangedFiles(files)
      : await candidateChangedFiles(projectDir, head);
  return { head, fingerprints: await fingerprintFiles(projectDir, changedFiles) };
}

export async function changedFilesSinceBaseline(
  projectDir: string,
  baseline: ChangedFilesBaseline,
): Promise<string[]> {
  const currentFiles = await candidateChangedFiles(projectDir, baseline.head);
  const current = await fingerprintFiles(projectDir, currentFiles);
  return currentFiles.filter((file) => baseline.fingerprints.get(file) !== current.get(file));
}

export async function refreshChangedFilesBaseline(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  absorbedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const currentFiles = await candidateChangedFiles(opts.projectDir, opts.baseline.head);
  const current = await fingerprintFiles(opts.projectDir, currentFiles);
  const next = new Map<string, string>();

  for (const file of currentFiles) {
    if (opts.absorbedFiles.has(file)) {
      const fingerprint = current.get(file);
      if (fingerprint !== undefined) next.set(file, fingerprint);
    } else {
      const previous = opts.baseline.fingerprints.get(file);
      if (previous !== undefined) next.set(file, previous);
    }
  }

  return { head: opts.baseline.head, fingerprints: next };
}

export async function inferTaskAcceptedChangedFiles(
  projectDir: string,
  task: Task,
  head: string | null,
): Promise<string[]> {
  const patterns = [
    task.file,
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];
  const changedFiles = await candidateChangedFiles(projectDir, head);
  return changedFiles.filter((file) =>
    patterns.some((pattern) => matchesActionPattern(file, pattern)),
  );
}
