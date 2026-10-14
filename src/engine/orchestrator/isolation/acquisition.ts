import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { resolveValidatedBlobPath } from '../../snapshots/blob-resolver.js';
import { collectTrackedFiles, hashFile } from '../../snapshots/files.js';
import { readManifest } from '../../snapshots/manifest.js';
import type { SnapshotManifest } from '../../../core/schemas/snapshot.js';
import { stripGitignoreBookkeeping } from '../approval/staged-project.js';
import { isInternalGitStatusPath, sessionDir, SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs.js';
import { assertPathConfined, isInsideRoot } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import {
  type AcquisitionBaseline,
  captureAcquisitionBaseline,
  type FileEntryFingerprint,
  readConfinedEntry,
  removeConfinedSymlink,
  writeConfinedEntry,
} from '../approval/file-snapshots/entry.js';

const FingerprintsSchema = z.record(
  z.string(),
  z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777),
  }),
);
const WorktreeLocationSchema = z.object({
  version: z.literal(1),
  worktreeDir: z.string().refine(isAbsolute),
});
const WorktreeBaselineSchema = z.discriminatedUnion('kind', [
  WorktreeLocationSchema.extend({
    kind: z.literal('known'),
    targetFiles: FingerprintsSchema,
    worktreeFiles: FingerprintsSchema,
  }),
  WorktreeLocationSchema.extend({ kind: z.literal('unknown') }),
]);

type WorktreeBaseline = { target: AcquisitionBaseline; worktree: AcquisitionBaseline };
type StoredWorktreeBaseline =
  | (WorktreeBaseline & { kind: 'known'; worktreeDir: string })
  | { kind: 'unknown'; worktreeDir: string };

const acquisitionError = {
  invalidBaseline: () =>
    error('isolation-baseline-invalid', 'The isolation input baseline is invalid.'),
} as const;

async function readBaseline(input: {
  projectDir: string;
  baselinePath: string;
  worktreeDir?: string | undefined;
}): Promise<StoredWorktreeBaseline | null> {
  const { projectDir, baselinePath, worktreeDir } = input;
  const entry = await readConfinedEntry(projectDir, baselinePath);
  if (entry.kind === 'absent') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(entry.bytes.toString('utf8'));
  } catch {
    throw acquisitionError.invalidBaseline();
  }
  const parsed = WorktreeBaselineSchema.safeParse(raw);
  if (!parsed.success) {
    throw acquisitionError.invalidBaseline();
  }
  if (
    worktreeDir !== undefined &&
    parsed.data.worktreeDir !== worktreeDir &&
    (await realpath(parsed.data.worktreeDir)) !== (await realpath(worktreeDir))
  )
    throw acquisitionError.invalidBaseline();
  if (parsed.data.kind === 'unknown')
    return { kind: 'unknown', worktreeDir: parsed.data.worktreeDir };
  const target = new Map(Object.entries(parsed.data.targetFiles));
  const worktree = new Map(Object.entries(parsed.data.worktreeFiles));
  for (const file of new Set([...target.keys(), ...worktree.keys()])) {
    assertPathConfined(file, projectDir);
    assertPathConfined(file, parsed.data.worktreeDir);
  }
  return { kind: 'known', target, worktree, worktreeDir: parsed.data.worktreeDir };
}

function baselinePathFor(projectDir: string, sessionId: string): string {
  return relative(projectDir, join(sessionDir(projectDir, sessionId), 'isolation-baseline.json'));
}

async function writeKnownBaseline(opts: {
  projectDir: string;
  baselinePath: string;
  worktreeDir: string;
  baseline: WorktreeBaseline;
}): Promise<void> {
  const { projectDir, baselinePath, worktreeDir, baseline } = opts;
  await writeConfinedSecureFileAsync(
    projectDir,
    baselinePath,
    `${JSON.stringify({
      version: 1,
      kind: 'known',
      worktreeDir,
      targetFiles: Object.fromEntries(baseline.target),
      worktreeFiles: Object.fromEntries(baseline.worktree),
    })}\n`,
  );
}

function sameFingerprint(
  a: FileEntryFingerprint | undefined,
  b: FileEntryFingerprint | undefined,
): boolean {
  return a?.sha256 === b?.sha256 && a?.mode === b?.mode;
}

function setFingerprint(
  baseline: Map<string, FileEntryFingerprint>,
  file: string,
  value: FileEntryFingerprint | undefined,
): void {
  if (value === undefined) baseline.delete(file);
  else baseline.set(file, value);
}

async function captureWorkspaceBaseline(
  projectDir: string,
  workspaceDir: string,
): Promise<AcquisitionBaseline> {
  if (!isInsideRoot(projectDir, workspaceDir)) return captureAcquisitionBaseline(workspaceDir);
  const baseline = new Map<string, FileEntryFingerprint>();
  for (const file of await collectTrackedFiles(workspaceDir, { ignoreProjectDir: projectDir })) {
    const entry = await readConfinedEntry(workspaceDir, file);
    if (entry.kind === 'file') baseline.set(file, { sha256: entry.sha256, mode: entry.mode });
  }
  return baseline;
}

async function synchronizeWorktree(opts: {
  projectDir: string;
  worktreeDir: string;
  baseline: WorktreeBaseline;
}): Promise<WorktreeBaseline> {
  const { projectDir, worktreeDir, baseline } = opts;
  const currentTarget = await captureAcquisitionBaseline(projectDir);
  const currentWorktree = await captureWorkspaceBaseline(projectDir, worktreeDir);
  const target = new Map(baseline.target);
  const worktree = new Map(baseline.worktree);
  const files = new Set([
    ...target.keys(),
    ...worktree.keys(),
    ...currentTarget.keys(),
    ...currentWorktree.keys(),
  ]);
  for (const file of files) {
    const targetNow = currentTarget.get(file);
    const worktreeNow = currentWorktree.get(file);
    if (sameFingerprint(targetNow, worktreeNow)) {
      setFingerprint(target, file, targetNow);
      setFingerprint(worktree, file, worktreeNow);
    }
  }
  return { target, worktree };
}

export async function prepareWorktreeAcquisition(opts: {
  projectDir: string;
  sessionId: string;
  worktreeDir: string;
  initialTargetBaseline: AcquisitionBaseline | undefined;
}): Promise<{ targetBaseline: AcquisitionBaseline }> {
  const { projectDir, worktreeDir } = opts;
  // This record belongs to the project session, outside the worker's directory.
  // It must survive a process restart without granting the worker write access.
  const baselinePath = baselinePathFor(projectDir, opts.sessionId);
  const previous =
    opts.initialTargetBaseline === undefined
      ? await readBaseline({ projectDir, baselinePath, worktreeDir })
      : {
          kind: 'known' as const,
          target: opts.initialTargetBaseline,
          worktree: await captureWorkspaceBaseline(projectDir, worktreeDir),
        };
  let targetBaseline: AcquisitionBaseline;
  if (previous === null || previous.kind === 'unknown') {
    // Legacy workspaces have no proof of their starting inputs. Preserve both
    // sides and allow only targets that still match the worker's current copy.
    // Record the location for recovery, without claiming known starting inputs.
    targetBaseline = await captureWorkspaceBaseline(projectDir, worktreeDir);
    await writeConfinedSecureFileAsync(
      projectDir,
      baselinePath,
      `${JSON.stringify({
        version: 1,
        kind: 'unknown',
        worktreeDir,
      })}\n`,
    );
  } else {
    const synchronized = await synchronizeWorktree({ projectDir, worktreeDir, baseline: previous });
    await writeKnownBaseline({ projectDir, baselinePath, worktreeDir, baseline: synchronized });
    targetBaseline = synchronized.target;
  }
  return { targetBaseline };
}

type BaseSnapshot = {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  manifest: SnapshotManifest;
  baseline: SnapshotManifest;
  entries: ReadonlyMap<string, SnapshotManifest['fileEntries'][number]>;
  baselineEntries: ReadonlyMap<string, SnapshotManifest['fileEntries'][number]>;
};

async function readBaseSnapshot(base: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
}): Promise<BaseSnapshot> {
  const manifest = await readManifest(base.projectDir, base.sessionId, base.snapshotId);
  const baseline =
    base.snapshotId === SNAPSHOT_BASELINE_ID
      ? manifest
      : await readManifest(base.projectDir, base.sessionId, SNAPSHOT_BASELINE_ID);
  return {
    ...base,
    manifest,
    baseline,
    entries: new Map(manifest.fileEntries.map((entry) => [entry.path, entry])),
    baselineEntries: new Map(baseline.fileEntries.map((entry) => [entry.path, entry])),
  };
}

// A snapshot stores a blob only for the files it captured; an unchanged file inherits the baseline's.
async function baseBlob(
  snapshot: BaseSnapshot,
  file: string,
  hash: string,
): Promise<{ path: string; mode: number | undefined } | null> {
  const entry = snapshot.entries.get(file);
  const inherited = entry === undefined && snapshot.baseline.fileHashes[file] === hash;
  const resolvedEntry = inherited ? snapshot.baselineEntries.get(file) : entry;
  if (resolvedEntry?.hash !== hash) return null;
  const path = await resolveValidatedBlobPath({
    projectDir: snapshot.projectDir,
    sessionId: snapshot.sessionId,
    snapshotId: inherited ? SNAPSHOT_BASELINE_ID : snapshot.snapshotId,
    path: file,
    entry: resolvedEntry,
  });
  return path === null ? null : { path, mode: resolvedEntry.mode };
}

export type RunBaseFile =
  | { kind: 'absent' }
  | { kind: 'new' }
  | { kind: 'unchanged' }
  | { kind: 'changed'; base: { bytes: Buffer; mode: number | undefined } | null };

/**
 * A reader of files at the run base, compared with the workspace: absent from both, new when the
 * base holds no copy of a file the workspace has (the walk skipped it, or listed it with the empty
 * hash of a file it could not read), unchanged, or changed with its base bytes and mode (null when
 * the snapshot holds no blob of it; the mode is undefined in a manifest older than modes). It reads the base snapshot once, however many files it then reads.
 */
export async function createRunBaseReader(input: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  workspaceDir: string;
}): Promise<(file: string) => Promise<RunBaseFile>> {
  const snapshot = await readBaseSnapshot(input);
  return async (file) => {
    assertPathConfined(file, input.workspaceDir);
    const current = await hashFile(join(input.workspaceDir, file));
    const hash = snapshot.manifest.fileHashes[file];
    if (hash === undefined || hash === '') {
      return current === null ? { kind: 'absent' } : { kind: 'new' };
    }
    if (current === hash) return { kind: 'unchanged' };
    const blob = await baseBlob(snapshot, file, hash);
    const base = blob === null ? null : { bytes: await readFile(blob.path), mode: blob.mode };
    // Isolation's own .gitignore lines are not a change of the run.
    if (
      file === '.gitignore' &&
      current !== null &&
      base !== null &&
      stripGitignoreBookkeeping(await readFile(join(input.workspaceDir, file), 'utf8')) ===
        stripGitignoreBookkeeping(base.bytes.toString('utf8'))
    ) {
      return { kind: 'unchanged' };
    }
    return { kind: 'changed', base };
  };
}

export async function reconcileWorkspaceToBase(input: {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  workspaceDir: string;
  keep: readonly string[];
}): Promise<void> {
  const { projectDir, workspaceDir } = input;
  const snapshot = await readBaseSnapshot(input);
  const { manifest } = snapshot;
  const keep = new Set(input.keep);
  for (const [file, hash] of Object.entries(manifest.fileHashes)) {
    if (keep.has(file) || isInternalGitStatusPath(file) || hash === '') continue;
    assertPathConfined(file, workspaceDir);
    if ((await hashFile(join(workspaceDir, file))) === hash) continue;
    const blob = await baseBlob(snapshot, file, hash);
    if (blob === null) continue;
    const current = await readConfinedEntry(workspaceDir, file);
    const bytes = await readFile(blob.path);
    if (
      file === '.gitignore' &&
      current.kind === 'file' &&
      stripGitignoreBookkeeping(current.bytes.toString('utf8')) ===
        stripGitignoreBookkeeping(bytes.toString('utf8'))
    )
      continue;
    await writeConfinedEntry(workspaceDir, file, {
      kind: 'file',
      bytes,
      sha256: hash,
      mode: current.kind === 'file' ? current.mode : 0o644,
    });
  }
  for (const file of await collectTrackedFiles(workspaceDir, { ignoreProjectDir: projectDir })) {
    if (keep.has(file) || isInternalGitStatusPath(file) || Object.hasOwn(manifest.fileHashes, file))
      continue;
    if (file === '.gitignore') {
      const entry = await readConfinedEntry(workspaceDir, file);
      if (entry.kind === 'file' && stripGitignoreBookkeeping(entry.bytes.toString('utf8')) === '')
        continue;
    }
    await removeConfinedSymlink(workspaceDir, file);
    await writeConfinedEntry(workspaceDir, file, { kind: 'absent' });
  }
}
