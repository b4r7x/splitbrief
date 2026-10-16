import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';
import { rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import {
  type ChangeEntry,
  removeWriteTemporaries,
  writeConfinedEntryOrLink,
} from '../approval/file-snapshots/entry.js';
import { type ApplyBackup, backupSideEntry, readApplyBackup, readBackupBlob } from './backup.js';
import { readApplyEntry, sameSideEntry, type SideEntry, unsafeEntryError } from './states.js';
import { transitionAndSave } from '../state-ops.js';

type ApplyBackupInput = { projectDir: string; sessionId: string; backupId: string };

export type ApplyBackupReconciliation = {
  written: string[];
  pending: string[];
  ambiguous: string[];
};

function matchesFingerprint(entry: ChangeEntry | null, side: SideEntry | undefined): boolean {
  return entry !== null && side !== undefined && sameSideEntry(entry, side);
}

async function classifyApplyBackup(
  projectDir: string,
  backup: ApplyBackup,
): Promise<ApplyBackupReconciliation> {
  const expected = new Map(backup.expected.map((entry) => [entry.path, backupSideEntry(entry)]));
  const replaced = new Map(backup.replaced.map((entry) => [entry.path, backupSideEntry(entry)]));
  const created = new Set(backup.created);
  const paths = [...new Set([...expected.keys(), ...replaced.keys(), ...created])].sort();
  const result: ApplyBackupReconciliation = { written: [], pending: [], ambiguous: [] };
  for (const path of paths) {
    const checkout = await readApplyEntry(projectDir, path);
    const before: SideEntry | undefined =
      replaced.get(path) ?? (created.has(path) ? { kind: 'absent' } : undefined);
    if (matchesFingerprint(checkout, expected.get(path))) result.written.push(path);
    else if (matchesFingerprint(checkout, before)) result.pending.push(path);
    else result.ambiguous.push(path);
  }
  return result;
}

export async function reconcileApplyBackup(
  input: ApplyBackupInput,
): Promise<ApplyBackupReconciliation> {
  const { projectDir, sessionId, backupId } = input;
  return classifyApplyBackup(projectDir, await readApplyBackup(projectDir, sessionId, backupId));
}

export async function restoreApplyBackup(input: ApplyBackupInput): Promise<{
  restored: string[];
  unchanged: string[];
  conflicts: string[];
}> {
  const { projectDir, sessionId, backupId } = input;
  const backup = await readApplyBackup(projectDir, sessionId, backupId);
  const reconciliation = await classifyApplyBackup(projectDir, backup);
  const replaced = new Map(backup.replaced.map((entry) => [entry.path, entry]));
  const expected = new Map(backup.expected.map((entry) => [entry.path, backupSideEntry(entry)]));
  const created = new Set(backup.created);
  const restored: string[] = [];
  const unchanged = [...reconciliation.pending];
  const conflicts = [...reconciliation.ambiguous];
  for (const path of reconciliation.written) {
    const before = replaced.get(path);
    let entry: ChangeEntry;
    if (before !== undefined && 'target' in before) {
      entry = { kind: 'symlink', target: before.target };
    } else if (before !== undefined) {
      entry = {
        kind: 'file',
        bytes: await readBackupBlob(projectDir, sessionId, backupId, before.sha256),
        sha256: before.sha256,
        mode: before.mode,
      };
    } else if (created.has(path)) {
      entry = { kind: 'absent' };
    } else {
      throw error('apply-backup-corrupt', `Apply backup has no before entry: ${path}`, { path });
    }
    const after = expected.get(path);
    if (matchesFingerprint(entry, after)) {
      unchanged.push(path);
      continue;
    }
    const conflict = error('apply-restore-conflict', `Checkout changed before restore: ${path}`, {
      path,
    });
    try {
      await writeConfinedEntryOrLink(projectDir, path, entry, async () => {
        if (!matchesFingerprint(await readApplyEntry(projectDir, path), after)) throw conflict;
      });
      restored.push(path);
    } catch (cause) {
      if (cause !== conflict && !unsafeEntryError(cause)) throw cause;
      conflicts.push(path);
    }
  }
  await removeWriteTemporaries(projectDir, [...expected.keys(), ...replaced.keys(), ...created]);
  // Deepest first: a folder Apply made goes once it is empty again. One that holds anything, or
  // that you replaced with a file or a link, stays.
  for (const dir of [...backup.createdDirs].sort().reverse()) {
    await rmdir(resolve(projectDir, dir)).catch((cause: unknown) => {
      if (isENOENT(cause)) return;
      if (isNodeError(cause) && (cause.code === 'ENOTEMPTY' || cause.code === 'ENOTDIR')) return;
      throw cause;
    });
  }
  return { restored: restored.sort(), unchanged: unchanged.sort(), conflicts: conflicts.sort() };
}

/** Undo after Apply: the checkout goes back to its pre-Apply bytes and the run records the undo. */
export async function undoApply(
  ref: SessionRef,
  state: WorkflowState,
): Promise<Awaited<ReturnType<typeof restoreApplyBackup>>> {
  const { applied } = state;
  if (applied === undefined) throw error('apply-not-undoable', 'Run was not applied.');
  if (applied.undone !== undefined) throw error('apply-not-undoable', 'Apply already undone.');
  const result = await restoreApplyBackup({ ...ref, backupId: applied.backupId });
  transitionAndSave(ref, state, { type: 'APPLY_UNDONE', conflicts: result.conflicts });
  return result;
}
