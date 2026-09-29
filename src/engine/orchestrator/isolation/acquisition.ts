import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import {
  isInternalGitStatusPath,
  sessionDir,
  SPLITBRIEF_DIR,
  TREES_DIR,
} from '../../../core/paths.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs.js';
import { getCurrentChangedFiles } from '../../../lib/git/files.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import {
  type AcquisitionBaseline,
  captureAcquisitionBaseline,
  type FileEntryFingerprint,
  type FileSnapshotEntry,
  matchesAcquisitionBaseline,
  readConfinedEntry,
  sameFileEntry,
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
  workspaceChanged: (file: string) =>
    error('isolation-workspace-changed', `Isolation file changed during synchronization: ${file}`, {
      file,
    }),
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
  if (!parsed.success || (worktreeDir !== undefined && parsed.data.worktreeDir !== worktreeDir)) {
    throw acquisitionError.invalidBaseline();
  }
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

/** Null leaves a halt with no worktree record to its existing recovery check. */
export async function worktreePromotionConflictIsResolved(input: {
  projectDir: string;
  sessionId: string;
  files: readonly string[];
  workspacePath: string;
}): Promise<boolean | null> {
  const { projectDir, sessionId, files, workspacePath } = input;
  const baseline = await readBaseline({
    projectDir,
    baselinePath: baselinePathFor(projectDir, sessionId),
  });
  if (baseline === null || baseline.worktreeDir !== workspacePath) return null;
  if (files.length === 0 || !(await lstat(baseline.worktreeDir)).isDirectory()) return false;
  for (const file of files) {
    const target = await readConfinedEntry(projectDir, file);
    const worktree = await readConfinedEntry(baseline.worktreeDir, file);
    if (sameFileEntry(target, worktree)) continue;
    if (baseline.kind === 'unknown') return false;
    if (await matchesAcquisitionBaseline(projectDir, file, baseline.target)) continue;
    if (await matchesAcquisitionBaseline(baseline.worktreeDir, file, baseline.worktree)) continue;
    return false;
  }
  return true;
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

function worktreeInput(file: string, target: FileSnapshotEntry): FileSnapshotEntry {
  if (file !== '.gitignore') return target;
  let bytes = target.kind === 'file' ? target.bytes : Buffer.alloc(0);
  for (const line of [`${SPLITBRIEF_DIR}/`, `${TREES_DIR}/`]) {
    const text = bytes.toString('utf8');
    if (text.split('\n').some((value) => value.trim() === line)) continue;
    const prefix = bytes.length > 0 && !text.endsWith('\n') ? '\n' : '';
    bytes = Buffer.concat([bytes, Buffer.from(`${prefix}${line}\n`)]);
  }
  return {
    kind: 'file',
    bytes,
    sha256: sha256Hex(bytes),
    mode: target.kind === 'file' ? target.mode : 0o600,
  };
}

async function synchronizeWorktree(opts: {
  projectDir: string;
  worktreeDir: string;
  baseline: WorktreeBaseline;
}): Promise<WorktreeBaseline> {
  const { projectDir, worktreeDir, baseline } = opts;
  const currentTarget = await captureAcquisitionBaseline(projectDir);
  const currentWorktree = await captureAcquisitionBaseline(worktreeDir);
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
      continue;
    }
    // Only a worker copy still matching its input can accept an operator edit.
    // If both sides changed, the old target fingerprint keeps promotion blocked.
    if (
      sameFingerprint(targetNow, target.get(file)) ||
      !sameFingerprint(worktreeNow, worktree.get(file))
    )
      continue;
    const entry = await readConfinedEntry(projectDir, file);
    const input = worktreeInput(file, entry);
    await writeConfinedEntry(worktreeDir, file, input, async () => {
      if (!(await matchesAcquisitionBaseline(worktreeDir, file, currentWorktree))) {
        throw acquisitionError.workspaceChanged(file);
      }
    });
    setFingerprint(
      target,
      file,
      entry.kind === 'file' ? { sha256: entry.sha256, mode: entry.mode } : undefined,
    );
    // Only the entry we wrote is input. A later worker edit must stay output.
    setFingerprint(
      worktree,
      file,
      input.kind === 'file' ? { sha256: input.sha256, mode: input.mode } : undefined,
    );
  }
  return { target, worktree };
}

export async function prepareWorktreeAcquisition(opts: {
  projectDir: string;
  sessionId: string;
  worktreeDir: string;
  seedSnapshot: ChangedFilesSnapshot | null;
  initialTargetBaseline: AcquisitionBaseline | undefined;
  fresh: boolean;
}): Promise<{ targetBaseline: AcquisitionBaseline; discarded: string[] }> {
  const { projectDir, worktreeDir, seedSnapshot } = opts;
  // This record belongs to the project session, outside the worker's directory.
  // It must survive a process restart without granting the worker write access.
  const baselinePath = baselinePathFor(projectDir, opts.sessionId);
  const previous =
    opts.initialTargetBaseline === undefined
      ? await readBaseline({ projectDir, baselinePath, worktreeDir })
      : {
          kind: 'known' as const,
          target: opts.initialTargetBaseline,
          worktree: await captureAcquisitionBaseline(worktreeDir),
        };
  let targetBaseline: AcquisitionBaseline;
  if (previous === null || previous.kind === 'unknown') {
    // Legacy workspaces have no proof of their starting inputs. Preserve both
    // sides and allow only targets that still match the worker's current copy.
    // Record the location for recovery, without claiming known starting inputs.
    targetBaseline = await captureAcquisitionBaseline(worktreeDir);
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
    await writeConfinedSecureFileAsync(
      projectDir,
      baselinePath,
      `${JSON.stringify({
        version: 1,
        kind: 'known',
        worktreeDir,
        targetFiles: Object.fromEntries(synchronized.target),
        worktreeFiles: Object.fromEntries(synchronized.worktree),
      })}\n`,
    );
    targetBaseline = synchronized.target;
  }
  const discarded: string[] = [];
  if (opts.fresh) {
    const changed =
      seedSnapshot === null
        ? await getCurrentChangedFiles(worktreeDir)
        : await getChangedFilesSinceSnapshot(worktreeDir, seedSnapshot);
    for (const file of changed) {
      if (file === '.gitignore' || file.endsWith('/') || isInternalGitStatusPath(file)) continue;
      if (!(await matchesAcquisitionBaseline(projectDir, file, targetBaseline))) continue;
      const source = await readConfinedEntry(worktreeDir, file);
      const target = await readConfinedEntry(projectDir, file);
      if (sameFileEntry(source, target)) continue;
      await writeConfinedEntry(worktreeDir, file, target, async () => {
        if (
          !(await matchesAcquisitionBaseline(projectDir, file, targetBaseline)) ||
          !sameFileEntry(source, await readConfinedEntry(worktreeDir, file))
        ) {
          throw acquisitionError.workspaceChanged(file);
        }
      });
      discarded.push(file);
    }
  }
  return { targetBaseline, discarded };
}
