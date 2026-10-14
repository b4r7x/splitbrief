import { existsSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getCommittedFilesSince } from '../../lib/git/diff.js';
import { getCurrentChangedFiles } from '../../lib/git/files.js';
import { resolveRunStartBase } from '../../lib/git/refs.js';
import { readHeadSha } from '../../lib/git/repository.js';
import { isInternalGitStatusPath } from '../../core/paths.js';
import { isENOENT } from '../../lib/process/errors.js';
import { isProcessOutputSink } from '../../lib/process/stdio-sinks.js';
import { assertExistingPathConfined, assertPathConfined } from '../../lib/path-confinement.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../core/scope/declared-set.js';
import type { Task } from '../../core/schemas/task.js';
import type {
  ChangedFilesSnapshot,
  PersistedChangedFilesBaseline,
} from '../../core/schemas/workflow.js';
import { readProjectSymlink } from './approval/file-snapshots/entry.js';
import { getChangedFilesSinceSnapshot } from './approval/file-snapshots/capture.js';
import { recordedTargetOutput } from './evidence/task.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { listWorkspaceEntries } from './isolation/entry-snapshot.js';
import { gitignoreDiffersOnlyBySplitbriefBookkeeping } from './isolation/cleanliness.js';

export type ChangedFilesBaseline = {
  head: string | null;
  /** values: a sha256 hex, 'missing', 'unreadable', or 'symlink:<target>' for a project symlink */
  fingerprints: Map<string, string>;
  runStartChangedFiles?: ReadonlySet<string> | undefined;
  activeTaskSnapshot?: ChangedFilesSnapshot | undefined;
};

export const UNREADABLE_FINGERPRINT = 'unreadable';

export function serializeChangedFilesBaseline(
  baseline: ChangedFilesBaseline,
): PersistedChangedFilesBaseline {
  return {
    head: baseline.head,
    fingerprints: Object.fromEntries(baseline.fingerprints),
    ...(baseline.runStartChangedFiles !== undefined && {
      runStartChangedFiles: [...baseline.runStartChangedFiles],
    }),
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
    ...(persisted.runStartChangedFiles !== undefined && {
      runStartChangedFiles: new Set(persisted.runStartChangedFiles),
    }),
    activeTaskSnapshot: persisted.activeTaskSnapshot,
  };
}

export function withActiveTaskSnapshot(
  baseline: ChangedFilesBaseline,
  activeTaskSnapshot: ChangedFilesSnapshot,
): ChangedFilesBaseline {
  return { ...baseline, activeTaskSnapshot };
}

export function userVisibleChangedFiles(files: string[]): string[] {
  return files.filter((file) => !isInternalGitStatusPath(file));
}

export function unreadableChangedFiles(baseline: ChangedFilesBaseline): string[] {
  return [...baseline.fingerprints]
    .filter(([, fingerprint]) => fingerprint === UNREADABLE_FINGERPRINT)
    .map(([file]) => file)
    .sort();
}

async function captureHead(projectDir: string): Promise<string | null> {
  if (!existsSync(join(projectDir, '.git'))) return null;
  return readHeadSha(projectDir);
}

async function candidateChangedFiles(projectDir: string, head: string | null): Promise<string[]> {
  if (!existsSync(join(projectDir, '.git'))) return listWorkspaceEntries(projectDir, projectDir);
  const base = await resolveRunStartBase({ projectDir, head });
  const working = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  const committed =
    base.kind === 'working-tree-only'
      ? []
      : userVisibleChangedFiles(await getCommittedFilesSince(projectDir, base.ref));
  return [...new Set([...working, ...committed])].sort();
}

async function fingerprintChangedFile(projectDir: string, file: string): Promise<string> {
  assertPathConfined(file, projectDir);
  const filePath = resolve(projectDir, file);
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      // A symlink that stays inside the project is fingerprinted by its target;
      // any other link is never followed.
      const target = await readProjectSymlink(projectDir, file);
      return target === null ? UNREADABLE_FINGERPRINT : `symlink:${target}`;
    }
    assertExistingPathConfined(file, projectDir);
    return sha256Hex(await readFile(filePath, 'utf-8'));
  } catch (cause) {
    if (isENOENT(cause)) return 'missing';
    return UNREADABLE_FINGERPRINT;
  }
}

export async function fingerprintFiles(
  projectDir: string,
  files: string[],
): Promise<Map<string, string>> {
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
  // Isolation's own .gitignore lines are not a change the run started with.
  const bookkeepingOnly =
    changedFiles.includes('.gitignore') &&
    (await gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir));
  return {
    head,
    fingerprints: await fingerprintFiles(projectDir, changedFiles),
    runStartChangedFiles: new Set(
      bookkeepingOnly ? changedFiles.filter((file) => file !== '.gitignore') : changedFiles,
    ),
  };
}

// The run's own stdout/stderr redirect targets keep growing between
// fingerprints; without the sink filter they would surface as user edits or
// planning-phase mutations.
export async function changedFilesSinceBaseline(
  projectDir: string,
  baseline: ChangedFilesBaseline,
): Promise<string[]> {
  const candidates = await candidateChangedFiles(projectDir, baseline.head);
  const files = [...new Set([...candidates, ...baseline.fingerprints.keys()])].sort();
  const current = await fingerprintFiles(projectDir, files);
  return files.filter(
    (file) =>
      baseline.fingerprints.get(file) !== current.get(file) &&
      !isProcessOutputSink(resolve(projectDir, file)),
  );
}

export async function refreshChangedFilesBaseline(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  absorbedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const candidates = await candidateChangedFiles(opts.projectDir, opts.baseline.head);
  const files = [
    ...new Set([...candidates, ...opts.baseline.fingerprints.keys(), ...opts.absorbedFiles]),
  ].sort();
  const current = await fingerprintFiles(opts.projectDir, files);
  const next = new Map<string, string>();

  for (const file of files) {
    if (opts.absorbedFiles.has(file)) {
      const fingerprint = current.get(file);
      if (fingerprint !== undefined) next.set(file, fingerprint);
    } else {
      const previous = opts.baseline.fingerprints.get(file);
      if (previous !== undefined) next.set(file, previous);
    }
  }

  return {
    head: opts.baseline.head,
    fingerprints: next,
    ...(opts.baseline.runStartChangedFiles !== undefined && {
      runStartChangedFiles: opts.baseline.runStartChangedFiles,
    }),
  };
}

/**
 * The brief's own writes since `head`: its declared files, plus every file the ledger records it
 * promoted. A brief may change an unplanned file, so the declared set alone misses its writes.
 */
export async function inferTaskOwnChangedFiles(
  ref: SessionRef,
  task: Task,
  head: string | null,
  codeDir: string,
  snapshot?: ChangedFilesSnapshot,
): Promise<string[]> {
  const recorded = new Set(recordedTargetOutput(ref, task).files.map((file) => file.path));
  const patterns = taskDeclaredPatterns(task);
  const changedFiles =
    snapshot === undefined
      ? await candidateChangedFiles(codeDir, head)
      : await getChangedFilesSinceSnapshot(codeDir, snapshot);
  return changedFiles.filter((file) => recorded.has(file) || isInDeclaredSet(file, patterns));
}
