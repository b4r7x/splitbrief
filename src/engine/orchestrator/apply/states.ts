import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isInternalGitStatusPath, SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { fsError } from '../../../lib/fs.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { resolveValidatedBlobPath } from '../../snapshots/blob-resolver.js';
import { walkProjectEntries } from '../../snapshots/files.js';
import { readManifest } from '../../snapshots/manifest.js';
import {
  type AcquisitionBaseline,
  captureAcquisitionBaseline,
  type FileSnapshotEntry,
  readConfinedEntry,
} from '../approval/file-snapshots/entry.js';
import { stripGitignoreBookkeeping } from '../approval/staged-project.js';

export type SideEntry =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string; mode: number }
  | { kind: 'symlink'; target: string };

export type BaseEntry = { kind: 'absent' } | { kind: 'file'; sha256: string; blob: string | null };

export type ApplyStates = {
  projectDir: string;
  workspaceDir: string;
  base: ReadonlyMap<string, BaseEntry>;
  ours: ReadonlyMap<string, SideEntry>;
  theirs: ReadonlyMap<string, SideEntry>;
  theirsBaseline: AcquisitionBaseline;
};

export async function readBaseBytes(path: string, entry: BaseEntry): Promise<Buffer | null> {
  if (entry.kind === 'absent' || entry.blob === null) return null;
  const bytes = await readFile(entry.blob);
  if (sha256Hex(bytes) !== entry.sha256) {
    throw error('apply-base-changed', `Base changed after Apply capture: ${path}`, { path });
  }
  return bytes;
}

async function normalizeWorkspaceEntry(
  entry: FileSnapshotEntry,
  path: string,
  base: ReadonlyMap<string, BaseEntry>,
): Promise<FileSnapshotEntry> {
  if (path !== '.gitignore' || entry.kind === 'absent') return entry;
  const baseEntry = base.get(path) ?? { kind: 'absent' };
  const baseBytes = await readBaseBytes(path, baseEntry);
  const bytes = Buffer.from(
    stripGitignoreBookkeeping(entry.bytes.toString('utf8'), baseBytes?.toString('utf8') ?? null),
  );
  if (bytes.length === 0 && baseEntry.kind === 'absent') return { kind: 'absent' };
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: entry.mode & 0o777 };
}

async function captureCheckoutState(projectDir: string): Promise<{
  entries: ReadonlyMap<string, SideEntry>;
  baseline: AcquisitionBaseline;
}> {
  const baseline = await captureAcquisitionBaseline(projectDir);
  const entries = new Map<string, SideEntry>();
  for (const [path, fingerprint] of baseline) {
    if (!isInternalGitStatusPath(path)) entries.set(path, { kind: 'file', ...fingerprint });
  }
  for await (const entry of walkProjectEntries(projectDir)) {
    if (isInternalGitStatusPath(entry.path) || entry.kind !== 'symlink') continue;
    entries.set(entry.path, {
      kind: 'symlink',
      target: await readlink(join(projectDir, entry.path)),
    });
  }
  return { entries, baseline };
}

async function captureWorkspaceState(
  projectDir: string,
  workspaceDir: string,
  base: ReadonlyMap<string, BaseEntry>,
): Promise<ReadonlyMap<string, SideEntry>> {
  const entries = new Map<string, SideEntry>();
  for await (const entry of walkProjectEntries(workspaceDir, { ignoreProjectDir: projectDir })) {
    if (isInternalGitStatusPath(entry.path) || entry.kind === 'directory') continue;
    if (entry.kind === 'symlink') {
      entries.set(entry.path, {
        kind: 'symlink',
        target: await readlink(join(workspaceDir, entry.path)),
      });
    } else {
      const file = await normalizeWorkspaceEntry(
        await readConfinedEntry(workspaceDir, entry.path),
        entry.path,
        base,
      );
      if (file.kind === 'file') {
        entries.set(entry.path, { kind: 'file', sha256: file.sha256, mode: file.mode & 0o777 });
      }
    }
  }
  return entries;
}

export async function captureApplyStates(input: {
  projectDir: string;
  sessionId: string;
  workspace: NonNullable<WorkflowState['workspace']>;
}): Promise<ApplyStates> {
  const { projectDir, sessionId, workspace } = input;
  const snapshotId = workspace.base.snapshotId;
  const manifest = await readManifest(projectDir, sessionId, snapshotId);
  const baseline =
    snapshotId === SNAPSHOT_BASELINE_ID
      ? manifest
      : await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
  const entries = new Map(manifest.fileEntries.map((entry) => [entry.path, entry]));
  const baselineEntries = new Map(baseline.fileEntries.map((entry) => [entry.path, entry]));
  const base = new Map<string, BaseEntry>();
  for (const [path, hash] of Object.entries(manifest.fileHashes)) {
    if (isInternalGitStatusPath(path)) continue;
    const entry = entries.get(path);
    const inherited = entry === undefined && baseline.fileHashes[path] === hash;
    const resolvedEntry = inherited ? baselineEntries.get(path) : entry;
    const blob =
      hash !== '' && resolvedEntry?.hash === hash
        ? await resolveValidatedBlobPath({
            projectDir,
            sessionId,
            snapshotId: inherited ? SNAPSHOT_BASELINE_ID : snapshotId,
            path,
            entry: resolvedEntry,
          })
        : null;
    base.set(path, { kind: 'file', sha256: hash, blob });
  }

  const workspaceDir = workspace.path;
  const [checkout, ours] = await Promise.all([
    captureCheckoutState(projectDir),
    captureWorkspaceState(projectDir, workspaceDir, base),
  ]);
  return {
    projectDir,
    workspaceDir,
    base,
    ours,
    theirs: checkout.entries,
    theirsBaseline: checkout.baseline,
  };
}

export function sameSideEntry(left: SideEntry, right: SideEntry): boolean {
  switch (left.kind) {
    case 'absent':
      return right.kind === 'absent';
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target;
    case 'file':
      return right.kind === 'file' && left.sha256 === right.sha256 && left.mode === right.mode;
  }
}

/** The stable fingerprint of one side of the run: absent, a file's hash, or a symlink's target. */
export function entryKey(entry: SideEntry): string {
  switch (entry.kind) {
    case 'absent':
      return 'absent';
    case 'symlink':
      return `symlink:${entry.target}`;
    case 'file':
      return `file:${entry.sha256}`;
  }
}

function differsFromBase(ours: SideEntry, base: BaseEntry): boolean {
  if (base.kind === 'absent') return ours.kind !== 'absent';
  // A base that recorded no hash never equals a side: it is an unknown, not an empty file.
  if (base.sha256 === '') return true;
  return ours.kind !== 'file' || ours.sha256 !== base.sha256;
}

/**
 * The run diff of a captured workspace: every path the workspace changed from
 * the run base, keyed to its entry fingerprint. A file's mode is deliberately
 * left out so a mode-only difference does not read as a content change.
 */
export function candidateOf(states: ApplyStates): Record<string, string> {
  const candidate: Record<string, string> = {};
  const paths = [...new Set([...states.base.keys(), ...states.ours.keys()])];
  for (const path of paths) {
    const base = states.base.get(path) ?? { kind: 'absent' };
    const ours = states.ours.get(path) ?? { kind: 'absent' };
    if (differsFromBase(ours, base)) candidate[path] = entryKey(ours);
  }
  return candidate;
}

export async function captureReviewedCandidate(input: {
  projectDir: string;
  sessionId: string;
  workspace: NonNullable<WorkflowState['workspace']>;
}): Promise<Record<string, string>> {
  return candidateOf(await captureApplyStates(input));
}

type ApplySide = 'ours' | 'theirs';

function sideChangedError(side: ApplySide, path: string) {
  return error(
    side === 'ours' ? 'apply-workspace-changed' : 'apply-checkout-changed',
    `${side === 'ours' ? 'Workspace' : 'Checkout'} changed after Apply capture: ${path}`,
    { path },
  );
}

function verifySideEntries(
  side: ApplySide,
  captured: ReadonlyMap<string, SideEntry>,
  current: ReadonlyMap<string, SideEntry>,
): void {
  const paths = [...new Set([...captured.keys(), ...current.keys()])].sort();
  for (const path of paths) {
    const expected = captured.get(path);
    const entry = current.get(path);
    if (expected === undefined || entry === undefined || !sameSideEntry(expected, entry)) {
      throw sideChangedError(side, path);
    }
  }
}

export async function verifyApplyStates(states: ApplyStates): Promise<void> {
  const [checkout, ours] = await Promise.all([
    captureCheckoutState(states.projectDir),
    captureWorkspaceState(states.projectDir, states.workspaceDir, states.base),
  ]);
  verifySideEntries('theirs', states.theirs, checkout.entries);
  verifySideEntries('ours', states.ours, ours);
}

type SideReadInput = {
  states: ApplyStates;
  path: string;
  side: ApplySide;
  expected: Extract<SideEntry, { kind: 'file' }>;
};

export function unsafeEntryError(cause: unknown): boolean {
  return (
    fsError.isInvalidId(cause) ||
    fsError.isSymlinkWrite(cause) ||
    pathConfinementError.isSymlinkRead(cause) ||
    pathConfinementError.isSymlinkParent(cause) ||
    pathConfinementError.isEscapesRoot(cause) ||
    (isNodeError(cause) && cause.code === 'ENOTDIR')
  );
}

export async function readApplyEntry(dir: string, path: string): Promise<FileSnapshotEntry | null> {
  assertPathConfined(path, dir);
  try {
    return await readConfinedEntry(dir, path);
  } catch (cause) {
    if (isENOENT(cause)) return { kind: 'absent' };
    if (unsafeEntryError(cause)) return null;
    throw cause;
  }
}

export async function readSideEntry(
  input: SideReadInput,
): Promise<Extract<FileSnapshotEntry, { kind: 'file' }>> {
  const { states, path, side } = input;
  const dir = side === 'ours' ? states.workspaceDir : states.projectDir;
  const observed = await readApplyEntry(dir, path);
  const current =
    observed !== null && side === 'ours'
      ? await normalizeWorkspaceEntry(observed, path, states.base)
      : observed;
  if (current === null || current.kind !== 'file' || !sameSideEntry(current, input.expected)) {
    throw sideChangedError(input.side, input.path);
  }
  return current;
}
