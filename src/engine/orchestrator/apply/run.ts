import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { awaitsApply, isAnsweredApplyRecovery } from '../../../core/sessions/run-status.js';
import { diffFileEntries } from '../../../lib/git/entry-diff.js';
import { error, matches } from '../../../utils/error.js';
import { countNoun } from '../../../utils/pluralize.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import {
  createBusTextHandler,
  publishError,
  publishRecoveryResolved,
  publishWarning,
} from '../events.js';
import {
  buildApplyConflictRecoveryIssue,
  buildApplyPartialRecoveryIssue,
} from '../recovery/builders/apply.js';
import { removeClosedRunWorkspace } from '../run/close.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';
import { writeConfinedEntry } from '../approval/file-snapshots/entry.js';
import { applyBackupDir } from './backup.js';
import { type ApplyConflict, type ApplyMerge, mergeApplyStates } from './merge.js';
import { reconcileApplyBackup, restoreApplyBackup } from './restore.js';
import {
  candidateOf,
  captureApplyStates,
  readBaseBytes,
  readSideEntry,
  sameSideEntry,
  type SideEntry,
} from './states.js';
import { writeApply } from './write.js';

type ApplyResult =
  | { outcome: 'applied'; state: WorkflowState; files: string[] }
  | { outcome: 'halted'; state: WorkflowState }
  | { outcome: 'review'; state: WorkflowState }
  | { outcome: 'needs-confirmation'; state: WorkflowState };

type TextMarkerConflict = ApplyConflict & {
  markers: Buffer;
  ours: Extract<SideEntry, { kind: 'file' }>;
  theirs: Extract<SideEntry, { kind: 'file' }>;
};

function raiseApplyHalt(
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>,
  state: WorkflowState,
  issue: RecoveryIssue,
  setTrackedState?: ((state: WorkflowState) => void) | undefined,
): WorkflowState {
  publishError({
    bus: wctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: {
      category: 'recovery',
      code: issue.reason === 'apply-partial' ? 'apply_partial' : 'apply_conflict',
    },
  });
  return raisePendingRecovery(wctx, state, issue, setTrackedState);
}

/**
 * A process that went away inside Apply leaves its `applying` record and no halt. This raises the
 * apply-partial halt that Retry and Restore answer, from what the checkout holds now.
 */
export async function haltCutApply(
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>,
  state: WorkflowState,
  backupId: string,
  setTrackedState?: ((state: WorkflowState) => void) | undefined,
): Promise<WorkflowState> {
  const reconciliation = await reconcileApplyBackup({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    backupId,
  });
  return raiseApplyHalt(
    wctx,
    state,
    buildApplyPartialRecoveryIssue({
      backupId,
      backupDir: applyBackupDir(wctx.projectDir, wctx.sessionId, backupId),
      reconciliation,
      createdAt: new Date().toISOString(),
    }),
    setTrackedState,
  );
}

export async function runApply(input: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
  overrideConfirmed?: boolean | undefined;
}): Promise<ApplyResult> {
  const { wctx, setTrackedState } = input;
  let { state } = input;
  let retrying = false;
  if (state.pendingRecovery !== undefined) {
    const recovery = state.pendingRecovery;
    if (!isAnsweredApplyRecovery(recovery)) {
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `Recovery is still pending (reason: ${recovery.reason}, status: ${recovery.status}); no Apply work was started. Available actions: ${recovery.availableActions.join(', ')}.`,
        safety: { category: 'recovery', code: 'recovery_pending_unresolved' },
      });
      return { outcome: 'halted', state };
    }
    const action = recovery.selectedAction;
    let restored: Awaited<ReturnType<typeof restoreApplyBackup>> | undefined;
    if (action === 'restore-backup') {
      const backupId = state.applying?.backupId ?? recoveryFactString(recovery.facts, 'backupId');
      if (backupId === undefined) {
        throw error('apply-backup-missing', 'Restore requires the Apply backup ID.');
      }
      restored = await restoreApplyBackup({
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
        backupId,
      });
      if (state.applying !== undefined) {
        state = transitionAndSave(wctx, state, { type: 'APPLY_RESTORED' });
        setTrackedState?.(state);
      }
    }
    state = transitionAndSave(wctx, state, { type: 'RESOLVE_PENDING_RECOVERY' });
    setTrackedState?.(state);
    publishRecoveryResolved({
      bus: wctx.bus,
      phase: state.phase,
      issue: recovery,
      action,
      outcome: 'continued',
    });
    if (restored !== undefined) {
      const message = `Restored Apply backup: put back ${countNoun(restored.restored.length, 'file')}`;
      if (restored.conflicts.length > 0) {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: `${message}; left as you changed them: ${restored.conflicts.join(', ')}`,
          safety: { category: 'recovery', code: 'apply_restore_conflict' },
        });
      } else {
        createBusTextHandler({ bus: wctx.bus, phase: state.phase })(message);
      }
      return { outcome: 'halted', state };
    }
    retrying = true;
  }
  const { workspace } = state;
  if (!awaitsApply(state) || workspace === undefined || workspace.kind === 'checkout') {
    throw error('apply-not-ready', 'Apply requires a reviewed worktree or staged-copy workspace.');
  }
  const halt = (issue: RecoveryIssue): { outcome: 'halted'; state: WorkflowState } => {
    state = raiseApplyHalt(wctx, state, issue, setTrackedState);
    return { outcome: 'halted', state };
  };
  if (state.applying !== undefined && !retrying) {
    return {
      outcome: 'halted',
      state: await haltCutApply(wctx, state, state.applying.backupId, setTrackedState),
    };
  }
  const states = await captureApplyStates({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspace,
  });
  const integratedMap =
    state.applyIntegrated === undefined
      ? undefined
      : new Map(state.applyIntegrated.map((entry) => [entry.path, entry.checkoutHash]));
  let merged: ApplyMerge;
  try {
    merged = await mergeApplyStates(states, integratedMap);
  } catch (cause) {
    if (
      (matches('apply-checkout-changed')(cause) || matches('apply-workspace-changed')(cause)) &&
      isRecord(cause.data) &&
      typeof cause.data.path === 'string'
    ) {
      return halt(
        buildApplyConflictRecoveryIssue({
          conflicts: [
            {
              path: cause.data.path,
              kind: matches('apply-workspace-changed')(cause)
                ? 'workspace-changed'
                : 'checkout-changed',
            },
          ],
          workspacePath: workspace.path,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    throw cause;
  }
  const absent: SideEntry = { kind: 'absent' };
  const buildMergedEntries = async (
    paths: readonly string[],
  ): Promise<{ path: string; checkoutHunks: string }[]> => {
    const entries: { path: string; checkoutHunks: string }[] = [];
    for (const path of paths) {
      const baseEntry = states.base.get(path) ?? absent;
      const theirsEntry = states.theirs.get(path) ?? absent;
      let checkoutHunks = '';
      if (
        theirsEntry.kind !== 'symlink' &&
        (baseEntry.kind !== 'file' || baseEntry.blob !== null) &&
        (baseEntry.kind !== theirsEntry.kind ||
          (baseEntry.kind === 'file' &&
            theirsEntry.kind === 'file' &&
            baseEntry.sha256 !== theirsEntry.sha256))
      ) {
        const [baseBytes, theirs] = await Promise.all([
          readBaseBytes(path, baseEntry),
          theirsEntry.kind === 'file'
            ? readSideEntry({ states, path, side: 'theirs', expected: theirsEntry })
            : null,
        ]);
        checkoutHunks = await diffFileEntries({
          path,
          before: baseBytes === null ? null : { bytes: baseBytes, mode: theirs?.mode ?? 0o644 },
          after: theirs === null ? null : { bytes: theirs.bytes, mode: theirs.mode },
        });
      }
      entries.push({ path, checkoutHunks });
    }
    return entries;
  };
  if (merged.conflicts.length > 0) {
    const textConflicts = merged.conflicts.filter(
      (conflict): conflict is TextMarkerConflict =>
        conflict.kind === 'text' &&
        conflict.markers !== undefined &&
        conflict.ours.kind === 'file' &&
        conflict.theirs.kind === 'file',
    );
    if (textConflicts.length === merged.conflicts.length) {
      const integrated: { path: string; checkoutHash: string }[] = [];
      const triage: TriageInput[] = [];
      for (const [index, conflict] of textConflicts.entries()) {
        await writeConfinedEntry(workspace.path, conflict.path, {
          kind: 'file',
          bytes: conflict.markers,
          sha256: sha256Hex(conflict.markers),
          mode: conflict.ours.mode,
        });
        integrated.push({ path: conflict.path, checkoutHash: conflict.theirs.sha256 });
        triage.push({
          id: `A${index + 1}`,
          kind: 'defect',
          source: 'apply',
          text: `Apply merge conflict in ${conflict.path}: resolve the conflict markers, keeping both the run's change and the checkout's change unless they compete`,
          file: conflict.path,
        });
      }
      state = transitionAndSave(wctx, state, {
        type: 'APPLY_REVIEW_START',
        merged: await buildMergedEntries(textConflicts.map((conflict) => conflict.path)),
        integrated,
        triage,
      });
      setTrackedState?.(state);
      createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
        `Apply wrote conflict markers for ${countNoun(textConflicts.length, 'file')} both sides changed (${textConflicts.map((conflict) => conflict.path).join(', ')}); the review turns them into fix tasks before Apply runs again.`,
      );
      return { outcome: 'review', state };
    }
    return halt(
      buildApplyConflictRecoveryIssue({
        conflicts: merged.conflicts,
        workspacePath: workspace.path,
        createdAt: new Date().toISOString(),
      }),
    );
  }
  const after = await captureApplyStates({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspace,
  });
  const reviewed = state.reviewedCandidate ?? candidateOf(states);
  const now = candidateOf(after);
  const changed = [...new Set([...Object.keys(reviewed), ...Object.keys(now)])]
    .filter((path) => now[path] !== reviewed[path])
    .filter(
      (path) =>
        reviewed[path] !== undefined ||
        !sameSideEntry(after.ours.get(path) ?? absent, states.theirs.get(path) ?? absent),
    )
    .sort();
  if (changed.length > 0) {
    state = transitionAndSave(wctx, state, {
      type: 'APPLY_REVIEW_START',
      merged: await buildMergedEntries(changed),
    });
    setTrackedState?.(state);
    createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
      `Your checkout changed ${countNoun(changed.length, 'file')} this run also changed (${changed.join(', ')}); the merged result goes through its checks and the review again before Apply.`,
    );
    return { outcome: 'review', state };
  }
  if (state.acceptedAsIs !== undefined && input.overrideConfirmed !== true && !retrying) {
    const findings = state.acceptedAsIs.findings;
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `Run accepted as is with ${countNoun(findings.length, 'open finding')}: ${findings.join('; ')}. No review checked them; Apply needs one confirmation (/run accept confirm).`,
      safety: { category: 'recovery', code: 'apply_override_unconfirmed' },
    });
    return { outcome: 'needs-confirmation', state };
  }
  const result = await writeApply({
    scope: wctx,
    state,
    states,
    files: merged.promote,
    setTrackedState,
  });
  state = result.state;
  switch (result.kind) {
    case 'changed':
      return halt(
        buildApplyConflictRecoveryIssue({
          conflicts: result.files.map((path) => ({ path, kind: 'checkout-changed' })),
          workspacePath: workspace.path,
          createdAt: new Date().toISOString(),
        }),
      );
    case 'partial':
      return halt(
        buildApplyPartialRecoveryIssue({
          backupId: result.backupId,
          backupDir: applyBackupDir(wctx.projectDir, wctx.sessionId, result.backupId),
          written: result.written,
          files: result.files,
          failedFile: result.failedFile,
          cause: result.cause,
          createdAt: new Date().toISOString(),
        }),
      );
    case 'applied':
      await removeClosedRunWorkspace(wctx, workspace, state.phase);
      return { outcome: 'applied', state, files: result.files };
  }
}
