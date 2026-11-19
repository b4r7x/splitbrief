import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { collectTrackedFiles } from '../../snapshots/files.js';
import { sessionDir } from '../../../core/paths.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs/secure.js';
import { assertPathConfined, isInsideRoot } from '../../../lib/fs/confinement.js';
import { error } from '../../../utils/error.js';
import {
  type AcquisitionBaseline,
  captureAcquisitionBaseline,
  type FileEntryFingerprint,
} from '../approval/file-snapshots/entry/baseline.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry/read.js';

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
  pinned?: boolean | undefined;
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
          worktree:
            opts.pinned === true
              ? opts.initialTargetBaseline
              : await captureWorkspaceBaseline(projectDir, worktreeDir),
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
    const synchronized =
      opts.pinned === true
        ? previous
        : await synchronizeWorktree({ projectDir, worktreeDir, baseline: previous });
    await writeKnownBaseline({ projectDir, baselinePath, worktreeDir, baseline: synchronized });
    targetBaseline = synchronized.target;
  }
  return { targetBaseline };
}
