import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { applyUnfinished, deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error, matches } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import { recordInterruptedCalls } from '../../calls/interrupted.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../events/workflow-cancel.js';
import { writeRunPatch } from '../apply/patch.js';
import { persistStoppedBriefEvidence } from '../evidence/persistence.js';
import { recordRejectEvidence } from '../evidence/task.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import {
  publishRecoveryActionSelected,
  publishRecoveryResolved,
  publishRunRejected,
  publishWarning,
} from '../events.js';
import { removeRunWorkspace } from '../isolation/remove-worktree.js';
import { finalizeRunAtRest } from '../session-lifecycle/finalize.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import {
  commitWorkflowState,
  MAX_STATE_CONFLICT_RETRIES,
  readWorkflowStateHead,
  rebaseOnPersistedWorkflowState,
  stateOpsError,
  transitionAndSave,
} from '../state-ops.js';
import { rejectRunSnapshot } from '../../snapshots/run/lifecycle.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import { APPLY_UNFINISHED_REFUSAL } from '../../../core/runtime/commands/messages.js';
import { listSessionIds, sessionsRootLabel } from '../../../core/sessions/orphans.js';
import { readWorkspaceRecord } from '../isolation/retention.js';
import { warnError } from '../../../lib/warn.js';

/**
 * Whether files the run wrote are still in the checkout. A checkout run's ledger books what each
 * brief left, the close books the brief a stop cut, and a halt or a skip that put files back takes
 * them out. An older run without a workspace has no such record: a brief that started stands in.
 */
function runLeftFilesInCheckout(
  ref: SessionRef,
  state: Pick<WorkflowState, 'workspace' | 'tasks'>,
): boolean {
  if (state.workspace === undefined) return state.tasks.some((task) => task.status !== 'pending');
  if (state.workspace.kind !== 'checkout') return false;
  return readEvidenceLedger(ref)?.tasks.some((task) => task.changedFiles.length > 0) ?? false;
}

export function filesStillOnDiskSuffix(
  ref: SessionRef,
  state: Pick<WorkflowState, 'workspace' | 'tasks'>,
): string {
  return runLeftFilesInCheckout(ref, state) ? ' The files it wrote are still on disk.' : '';
}

/** The headless close line's tail: where the closed run's changes are. The run screen has its Patch row. */
export function closedChangesSuffix(ref: SessionRef, state: WorkflowState): string {
  const patch = state.closed?.patch;
  return patch === undefined
    ? filesStillOnDiskSuffix(ref, state)
    : ` Run changes not applied are saved in ${patch}; apply them with git apply.`;
}

export async function removeClosedRunWorkspace(
  scope: SessionRef & { bus?: EventBus | undefined },
  workspace: NonNullable<WorkflowState['workspace']>,
  phase: WorkflowState['phase'],
): Promise<void> {
  try {
    await removeRunWorkspace(scope.projectDir, scope.sessionId, workspace);
  } catch (err) {
    if (scope.bus !== undefined) {
      publishWarning({
        bus: scope.bus,
        phase,
        message: `Could not remove the run workspace at ${workspace.path}: ${toErrorMessage(err)}`,
      });
    }
  }
  scope.bus?.publish({ type: 'workspace_closed', ts: Date.now(), phase });
}

export async function removeClosedRunWorkspaces(projectDir: string): Promise<void> {
  let sessionIds: string[];
  try {
    sessionIds = listSessionIds(projectDir);
  } catch (err) {
    warnError(
      `Could not list ${sessionsRootLabel(projectDir)}, so leftover workspaces from closed runs may remain`,
      err,
    );
    return;
  }
  for (const sessionId of sessionIds) {
    const ref = { projectDir, sessionId };
    let workspacePath: string | undefined;
    try {
      const head = readWorkflowStateHead(ref);
      if (head === null) continue;
      const { state } = head;
      const status = deriveRunStatus({ state, liveness: 'not-alive' });
      if (status.kind !== 'closed') continue;
      const workspace = state.workspace;
      if (
        workspace === undefined ||
        (workspace.kind !== 'worktree' && workspace.kind !== 'staged-copy')
      ) {
        continue;
      }
      workspacePath = workspace.path;
      const record = await readWorkspaceRecord(ref);
      if (record === null) continue;
      await removeRunWorkspace(projectDir, sessionId, workspace);
    } catch (err) {
      if (workspacePath !== undefined) {
        warnError(`Could not remove the run workspace at ${workspacePath}`, err);
      }
    }
  }
}

export async function closeRunIfOpen(
  scope: SessionRef & { bus?: EventBus | undefined },
  state: WorkflowState,
  as?: 'discarded',
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const warn = (message: string, phase: WorkflowState['phase']): void => {
    if (scope.bus !== undefined) publishWarning({ bus: scope.bus, phase, message });
  };
  let workspaceToRemove: NonNullable<WorkflowState['workspace']> | undefined;
  let patchHandled = false;
  let patch: string | undefined;
  let warning: string | undefined;
  // A tool left running by a crashed process still writes into the workspace the patch is cut from.
  await reapOrphanRunners(scope.projectDir);

  for (let attempt = 0; ; attempt += 1) {
    // A run stopped before it ever saved a state still closes: the close then
    // creates the head instead of failing the CAS against a file that is not there.
    const head = readWorkflowStateHead(scope);
    const latest = head === null ? state : rebaseOnPersistedWorkflowState(scope, state);
    const status = deriveRunStatus({ state: latest, liveness: 'not-alive' });
    if (status.kind === 'closed') {
      return { state: latest, closedNow: false };
    }
    assertCanCloseRun(latest);

    if (!patchHandled) {
      patchHandled = true;
      const workspace = latest.workspace;
      if (workspace !== undefined && workspace.kind !== 'checkout') {
        workspaceToRemove = workspace;
        if (existsSync(workspace.path)) {
          const patchPath = await writeRunPatch(scope, workspace);
          if (patchPath !== null) patch = relative(scope.projectDir, patchPath);
        } else {
          warning = `The run workspace at ${workspace.path} is gone; no run patch was written.`;
        }
      }
    }

    const closedAs = as ?? (status.kind === 'ready-to-apply' ? 'discarded' : undefined);
    const result = commitWorkflowState({
      ref: scope,
      expected: head === null ? null : latest,
      next: transition(latest, {
        type: 'CLOSE_RUN',
        ...(closedAs !== undefined && { as: closedAs }),
        ...(patch !== undefined && { patch }),
      }),
    });
    if (result.kind === 'committed') {
      await persistStoppedBriefEvidence(scope, latest);
      // A checkout run closes as discarded only after a reject put its changes back.
      if (
        latest.workspace?.kind === 'checkout' &&
        as === undefined &&
        runLeftFilesInCheckout(scope, latest)
      ) {
        warning =
          'This run edited your checkout directly: its changes are already there, so nothing is unapplied and no run patch was written.';
      }
      if (warning !== undefined) warn(warning, result.state.phase);
      if (workspaceToRemove !== undefined) {
        await removeClosedRunWorkspace(scope, workspaceToRemove, result.state.phase);
      }
      return { state: result.state, closedNow: true };
    }
    if (result.kind === 'durability-uncertain')
      throw stateOpsError.durabilityUncertain(scope.sessionId);
    if (attempt === MAX_STATE_CONFLICT_RETRIES) {
      throw stateOpsError.conflictExhausted({
        operation: 'transition',
        expectedRevision: latest.stateRevision ?? 0,
        observedRevision: readWorkflowStateHead(scope)?.state.stateRevision ?? null,
        attempts: attempt + 1,
        retryLimit: MAX_STATE_CONFLICT_RETRIES,
      });
    }
  }
}

/**
 * `/run reject confirm` on a run that wrote the checkout: puts back the run's recorded changes and
 * records the reject. A checkout run that the reject left nothing of closes as discarded. One that
 * kept files the user changed stays open: no brief books the files the reject put back, and each
 * passed brief that had booked one is open again, so Continue builds it again. An older run
 * without a workspace record only records the reject.
 */
export async function rejectCheckoutRun(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState | null,
): Promise<{
  result: RejectRunSnapshotResult;
  closure: { state: WorkflowState; closedNow: boolean } | null;
}> {
  const result = await rejectRunSnapshot(scope.projectDir, scope.sessionId);
  if (result.status !== 'rejected') return { result, closure: null };
  publishRunRejected(scope.bus, result);
  if (state?.workspace?.kind !== 'checkout') return { result, closure: null };
  if (result.conflictedPaths.length === 0 && result.missingSnapshotFiles.length === 0) {
    return { result, closure: await closeRunIfOpen(scope, state, 'discarded') };
  }
  const removed = [...result.restoredPaths, ...result.deletedPaths];
  const ledger = readEvidenceLedger(scope);
  const booked = (ledger?.tasks ?? [])
    .filter((entry) => entry.changedFiles.some((file) => removed.includes(file)))
    .map((entry) => entry.id);
  const next = transitionAndSave(scope, rebaseOnPersistedWorkflowState(scope, state), {
    type: 'RECORD_REJECT',
    removed,
    booked,
  });
  if (ledger !== null && booked.length > 0) {
    mutateEvidenceLedger(scope, (latest) =>
      recordRejectEvidence({ ledger: latest ?? ledger, removed, tasks: next.tasks }),
    );
  }
  return { result, closure: null };
}

export const endRunError = {
  applying: () => error('end-run-while-applying', APPLY_UNFINISHED_REFUSAL),
  isApplying: matches('end-run-while-applying'),
};

export function assertCanCloseRun(state: WorkflowState): void {
  if (applyUnfinished(state)) throw endRunError.applying();
}

/**
 * A user stop stopped work only when it left the run open or closed it as ended. End run on a
 * ready run is its Discard, and a complete run had nothing left to stop.
 */
export function userStopStoppedWork(state: WorkflowState): boolean {
  const status = deriveRunStatus({ state, liveness: 'not-alive' });
  return status.kind === 'open' || (status.kind === 'closed' && status.as === 'ended');
}

export async function endRun(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
  atRestFrom?: number,
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const latest = rebaseOnPersistedWorkflowState(scope, state);
  const issue = latest.pendingRecovery;
  const closure = await closeRunIfOpen(scope, latest);
  if (closure.closedNow) {
    if (issue !== undefined) {
      publishRecoveryActionSelected({
        bus: scope.bus,
        phase: latest.phase,
        issue,
        action: 'end-run',
      });
      publishRecoveryResolved({
        bus: scope.bus,
        phase: closure.state.phase,
        issue,
        action: 'end-run',
        outcome: 'aborted',
      });
    }
    if (userStopStoppedWork(closure.state)) {
      scope.bus.publish({
        type: 'workflow_cancelled',
        ts: Date.now(),
        phase: closure.state.phase,
        reason: WORKFLOW_CANCEL_REASON_USER,
        ...(atRestFrom !== undefined && { atRestFrom }),
      });
    }
  }
  return closure;
}

export async function endRunAtRest(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const atRestFrom = Date.now();
  await recordInterruptedCalls(scope, rebaseOnPersistedWorkflowState(scope, state));
  const closure = await endRun(scope, state, atRestFrom);
  finalizeRunAtRest({ ref: scope, state: closure.state });
  return closure;
}
