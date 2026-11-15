import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import type { TriageInput } from '../../../core/schemas/review/verdict.js';
import { formatApplyRestoreCounts } from '../../../core/runtime/commands/messages.js';
import { isAnsweredApplyRecovery } from '../../../core/sessions/run/status.js';
import { error, matches } from '../../../utils/error.js';
import { countNoun } from '../../../utils/pluralize.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { isRecord } from '../../../utils/type-guards.js';
import { publishWarning } from '../publish/notice.js';
import { publishRecoveryResolved } from '../publish/recovery.js';
import { publishFixCycleStarted } from '../publish/review.js';
import { createBusTextHandler } from '../publish/runner.js';
import {
  buildApplyConflictRecoveryIssue,
  buildApplyPartialRecoveryIssue,
} from '../recovery/builders/apply.js';
import { removeClosedRunWorkspace } from '../isolation/closed-runs.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { writeConfinedEntry } from '../approval/file-snapshots/entry/write.js';
import { applyBackupDir } from './backup.js';
import { handOff } from './hand-off.js';
import {
  type ApplyConflict,
  type ApplyMerge,
  buildMergedEntries,
  mergeApplyStates,
} from './merge.js';
import { restoreApplyBackup } from './restore.js';
import { candidateOf, captureApplyStates, sameSideEntry, type SideEntry } from './states.js';
import { writeApply } from './write.js';
import { raiseApplyHalt } from './halt.js';
import type { ApplyInput, ApplyResult, ApplyRun, ApplyState } from './types.js';

type TextMarkerConflict = ApplyConflict & {
  markers: Buffer;
  ours: Extract<SideEntry, { kind: 'file' }>;
};

/**
 * Follows the answer to an Apply halt. Restore puts the checkout back and ends Apply; Retry returns
 * nothing, so Apply goes on from the files it already wrote.
 */
export async function answerApplyRecovery(
  input: Pick<ApplyInput, 'wctx' | 'setTrackedState'>,
  shared: ApplyState,
  recovery: RecoveryIssue,
): Promise<ApplyResult | undefined> {
  const { wctx, setTrackedState } = input;
  if (!isAnsweredApplyRecovery(recovery)) {
    publishWarning({
      bus: wctx.bus,
      phase: shared.state.phase,
      message: `Recovery is still pending (reason: ${recovery.reason}, status: ${recovery.status}); no Apply work was started. Available actions: ${recovery.availableActions.join(', ')}.`,
      safety: { category: 'recovery', code: 'recovery_pending_unresolved' },
    });
    return { outcome: 'halted', state: shared.state };
  }
  const action = recovery.selectedAction;
  let restored: Awaited<ReturnType<typeof restoreApplyBackup>> | undefined;
  if (action === 'restore-backup') {
    const backupId =
      shared.state.applying?.backupId ?? recoveryFactString(recovery.facts, 'backupId');
    if (backupId === undefined) {
      throw error('apply-backup-missing', 'Restore requires the Apply backup ID.');
    }
    restored = await restoreApplyBackup({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      backupId,
    });
    if (shared.state.applying !== undefined) {
      shared.state = transitionAndSave(wctx, shared.state, { type: 'APPLY_RESTORED' });
      setTrackedState?.(shared.state);
    }
  }
  shared.state = transitionAndSave(wctx, shared.state, { type: 'RESOLVE_PENDING_RECOVERY' });
  setTrackedState?.(shared.state);
  publishRecoveryResolved({
    bus: wctx.bus,
    phase: shared.state.phase,
    issue: recovery,
    action,
    outcome: 'continued',
  });
  if (restored === undefined) return undefined;
  const message = `Restored Apply backup: ${formatApplyRestoreCounts(restored)}`;
  if (restored.conflicts.length > 0) {
    publishWarning({
      bus: wctx.bus,
      phase: shared.state.phase,
      message: `${message}; left as you changed them: ${restored.conflicts.join(', ')}`,
      safety: { category: 'recovery', code: 'apply_restore_conflict' },
    });
  } else {
    createBusTextHandler({ bus: wctx.bus, phase: shared.state.phase })(message);
  }
  return { outcome: 'restored', state: shared.state, files: restored.restored };
}

function halt(run: ApplyRun, shared: ApplyState, issue: RecoveryIssue): ApplyResult {
  shared.state = raiseApplyHalt(run.wctx, shared.state, issue, run.setTrackedState);
  return { outcome: 'halted', state: shared.state };
}

/** Merges the three states into the workspace. A side that changed during the merge halts Apply. */
export async function mergeOrHalt(
  run: ApplyRun,
  shared: ApplyState,
): Promise<ApplyMerge | ApplyResult> {
  const integratedMap =
    shared.state.applyIntegrated === undefined
      ? undefined
      : new Map(shared.state.applyIntegrated.map((record) => [record.path, record]));
  try {
    return await mergeApplyStates(run.states, integratedMap);
  } catch (cause) {
    if (
      (matches('apply-checkout-changed')(cause) || matches('apply-workspace-changed')(cause)) &&
      isRecord(cause.data) &&
      typeof cause.data.path === 'string'
    ) {
      return halt(
        run,
        shared,
        buildApplyConflictRecoveryIssue({
          conflicts: [
            {
              path: cause.data.path,
              kind: matches('apply-workspace-changed')(cause)
                ? 'workspace-changed'
                : 'checkout-changed',
            },
          ],
          workspacePath: run.workspace.path,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    throw cause;
  }
}

/**
 * Text conflicts get their markers in the workspace and go to the review as fix tasks. Any other
 * conflict, and any conflict under REVIEW None, halts Apply.
 */
export async function settleConflicts(
  run: ApplyRun,
  shared: ApplyState,
  conflicts: ApplyConflict[],
): Promise<ApplyResult> {
  const { wctx, workspace } = run;
  const textConflicts = conflicts.filter(
    (conflict): conflict is TextMarkerConflict =>
      conflict.kind === 'text' && conflict.markers !== undefined && conflict.ours.kind === 'file',
  );
  if (textConflicts.length === conflicts.length && !run.reviewNone) {
    const triage: TriageInput[] = [];
    for (const [index, conflict] of textConflicts.entries()) {
      await writeConfinedEntry(workspace.path, conflict.path, {
        kind: 'file',
        bytes: conflict.markers,
        sha256: sha256Hex(conflict.markers),
        mode: conflict.ours.mode,
      });
      triage.push({
        id: `A${index + 1}`,
        kind: 'defect',
        source: 'apply',
        text: `Apply merge conflict in ${conflict.path}: resolve the conflict markers, keeping both the run's change and the checkout's change unless they compete`,
        file: conflict.path,
      });
    }
    shared.state = transitionAndSave(wctx, handOff(shared.state, textConflicts), {
      type: 'APPLY_REVIEW_START',
      merged: await buildMergedEntries(
        run.states,
        textConflicts.map((conflict) => conflict.path),
      ),
      triage,
    });
    run.setTrackedState?.(shared.state);
    createBusTextHandler({ bus: wctx.bus, phase: shared.state.phase })(
      `Apply wrote conflict markers for ${countNoun(textConflicts.length, 'file')} both sides changed (${textConflicts.map((conflict) => conflict.path).join(', ')}); the review turns them into fix tasks before Apply runs again.`,
    );
    return { outcome: 'review', state: shared.state };
  }
  // The run's own entry of an unsupported file cannot land, so the halt hands off the rest.
  shared.state = handOff(
    shared.state,
    conflicts.filter((conflict) => conflict.kind !== 'unsupported-entry'),
  );
  return halt(
    run,
    shared,
    buildApplyConflictRecoveryIssue({
      conflicts,
      workspacePath: workspace.path,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * A merge that changed the files the review judged sends the merged result back to its checks, and
 * to the review under a seat review, before Apply writes it. No such change: no result.
 */
export async function recheckChangedMerge(
  run: ApplyRun,
  shared: ApplyState,
): Promise<ApplyResult | undefined> {
  const { wctx, workspace, states, reviewNone } = run;
  const after = await captureApplyStates({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspace,
  });
  const reviewed = shared.state.reviewedCandidate ?? candidateOf(states);
  const now = candidateOf(after);
  const changed = [...new Set([...Object.keys(reviewed), ...Object.keys(now)])]
    .filter((path) => now[path] !== reviewed[path])
    .filter(
      (path) =>
        reviewed[path] !== undefined ||
        !sameSideEntry(
          after.ours.get(path) ?? { kind: 'absent' },
          states.theirs.get(path) ?? { kind: 'absent' },
        ),
    )
    .sort();
  if (changed.length === 0) return undefined;
  shared.state = transitionAndSave(wctx, shared.state, {
    type: reviewNone ? 'APPLY_RECHECK_START' : 'APPLY_REVIEW_START',
    merged: await buildMergedEntries(states, changed),
  });
  run.setTrackedState?.(shared.state);
  if (!reviewNone) publishFixCycleStarted(wctx.bus, shared.state, []);
  createBusTextHandler({ bus: wctx.bus, phase: shared.state.phase })(
    `Your checkout changed ${countNoun(changed.length, 'file')} this run also changed (${changed.join(', ')}); the merged result goes through its checks${reviewNone ? '' : ' and the review'} again before Apply.`,
  );
  return { outcome: 'review', state: shared.state };
}

/** Writes the merged files into the checkout and closes the run workspace once all of them land. */
export async function writeMerged(
  run: ApplyRun,
  shared: ApplyState,
  files: string[],
): Promise<ApplyResult> {
  const { wctx, workspace } = run;
  const result = await writeApply({
    scope: wctx,
    state: shared.state,
    states: run.states,
    files,
    setTrackedState: run.setTrackedState,
  });
  shared.state = result.state;
  switch (result.kind) {
    case 'changed':
      return halt(
        run,
        shared,
        buildApplyConflictRecoveryIssue({
          conflicts: result.files.map((path) => ({ path, kind: 'checkout-changed' })),
          workspacePath: workspace.path,
          createdAt: new Date().toISOString(),
        }),
      );
    case 'partial':
      return halt(
        run,
        shared,
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
      await removeClosedRunWorkspace(wctx, workspace, shared.state.phase);
      return { outcome: 'applied', state: shared.state, files: result.files };
  }
}
