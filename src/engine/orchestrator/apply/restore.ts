import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';
import { rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasErrnoCode, isENOENT } from '../../../utils/errno.js';
import { withCheckoutWriteLock } from '../../checkout-write.js';
import {
  beginCheckoutWriter,
  otherCheckoutWritesSince,
  type CheckoutWrite,
} from '../../checkout-writers.js';
import { acquireLiveness } from '../run/liveness.js';
import { checkoutFingerprint } from '../isolation/checkout-entries.js';
import { writeConfinedEntryOrLink } from '../approval/file-snapshots/entry/write.js';
import type { ChangeEntry } from '../approval/file-snapshots/entry/read.js';
import {
  type ApplyBackup,
  backupSideEntry,
  readApplyBackup,
  readBackupBlob,
  removeApplyWriteTemporaries,
} from './backup.js';
import { sameSideEntry, type SideEntry } from './states.js';
import { readApplyEntry, unsafeEntryError } from './entry-read.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { refreshSessionRow } from '../session-lifecycle/finalize.js';

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
  ref: SessionRef,
  backup: ApplyBackup,
): Promise<ApplyBackupReconciliation> {
  const expected = new Map(backup.expected.map((entry) => [entry.path, backupSideEntry(entry)]));
  const replaced = new Map(backup.replaced.map((entry) => [entry.path, backupSideEntry(entry)]));
  const created = new Set(backup.created);
  const paths = [...new Set([...expected.keys(), ...replaced.keys(), ...created])].sort();
  const foreignWrites = otherCheckoutWritesSince(ref, backup.checkoutRevision ?? 0, paths);
  const result: ApplyBackupReconciliation = { written: [], pending: [], ambiguous: [] };
  for (const path of paths) {
    const checkout = await readApplyEntry(ref.projectDir, path);
    const before: SideEntry | undefined =
      replaced.get(path) ?? (created.has(path) ? { kind: 'absent' } : undefined);
    if (matchesFingerprint(checkout, before)) result.pending.push(path);
    else if (matchesFingerprint(checkout, expected.get(path)) && !foreignWrites.has(path)) {
      result.written.push(path);
    } else result.ambiguous.push(path);
  }
  return result;
}

export async function reconcileApplyBackup(
  input: ApplyBackupInput,
): Promise<ApplyBackupReconciliation> {
  const { projectDir, sessionId, backupId } = input;
  return classifyApplyBackup(input, await readApplyBackup(projectDir, sessionId, backupId));
}

/** `removed` names the paths of `restored` that Apply had created, so restoring them deleted them. */
export async function restoreApplyBackup(input: ApplyBackupInput): Promise<{
  restored: string[];
  removed: string[];
  unchanged: string[];
  conflicts: string[];
}> {
  const { projectDir, sessionId, backupId } = input;
  const backup = await readApplyBackup(projectDir, sessionId, backupId);
  return withCheckoutWriteLock(projectDir, async () => {
    const writer = beginCheckoutWriter({ projectDir, sessionId });
    const receipts: CheckoutWrite[] = [];
    let completed = false;
    try {
      const result = await restoreBackupEntries(input, backup, receipts);
      for (const path of result.conflicts) receipts.push([path, null]);
      completed = true;
      return result;
    } finally {
      writer.finish(completed ? receipts : backup.expected.map(({ path }) => [path, null]));
    }
  });
}

async function restoreBackupEntries(
  input: ApplyBackupInput,
  backup: ApplyBackup,
  receipts: CheckoutWrite[],
) {
  const { projectDir, sessionId, backupId } = input;
  const reconciliation = await classifyApplyBackup(input, backup);
  const replaced = new Map(backup.replaced.map((entry) => [entry.path, entry]));
  const expected = new Map(backup.expected.map((entry) => [entry.path, backupSideEntry(entry)]));
  const created = new Set(backup.created);
  const restored: string[] = [];
  const removed: string[] = [];
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
    if (after === undefined) {
      conflicts.push(path);
      continue;
    }
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
      receipts.push([
        path,
        { before: checkoutFingerprint(after), after: checkoutFingerprint(entry), proven: true },
      ]);
      restored.push(path);
      if (entry.kind === 'absent') removed.push(path);
    } catch (cause) {
      if (cause !== conflict && !unsafeEntryError(cause)) throw cause;
      conflicts.push(path);
    }
  }
  await removeApplyWriteTemporaries(projectDir, backup);
  // Deepest first: a folder Apply made goes once it is empty again. One that holds anything, or
  // that you replaced with a file or a link, stays.
  for (const dir of [...backup.createdDirs].sort().reverse()) {
    await rmdir(resolve(projectDir, dir)).catch((cause: unknown) => {
      if (isENOENT(cause)) return;
      if (hasErrnoCode(cause, 'ENOTEMPTY', 'ENOTDIR')) return;
      throw cause;
    });
  }
  return {
    restored: restored.sort(),
    removed: removed.sort(),
    unchanged: unchanged.sort(),
    conflicts: conflicts.sort(),
  };
}

/** Undo after Apply: the checkout goes back to its pre-Apply bytes and the run records the undo. */
export async function undoApply(
  ref: SessionRef,
  selectedState: WorkflowState,
): Promise<Awaited<ReturnType<typeof restoreApplyBackup>>> {
  const release = await acquireLiveness({ ...ref, feature: selectedState.feature });
  try {
    const state = rebaseOnPersistedWorkflowState(ref, selectedState);
    const { applied } = state;
    if (applied === undefined) throw error('apply-not-undoable', 'Run was not applied.');
    if (applied.undone !== undefined) throw error('apply-not-undoable', 'Apply already undone.');
    const result = await restoreApplyBackup({ ...ref, backupId: applied.backupId });
    refreshSessionRow(
      ref,
      transitionAndSave(ref, state, { type: 'APPLY_UNDONE', conflicts: result.conflicts }),
    );
    return result;
  } finally {
    await release();
  }
}
