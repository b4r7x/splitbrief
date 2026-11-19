import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { applyUnfinished, deriveRunStatus } from '../../../core/sessions/run/status.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { StagedWorkspaceLeafSchema } from '../../../core/schemas/retained-workspace.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error, matches } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import { writeRunPatch } from '../apply/patch.js';
import { persistStoppedBriefEvidence } from '../evidence/persistence.js';
import { recordRejectEvidence } from '../evidence/task.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { publishWarning } from '../publish/notice.js';
import { publishRunRejected } from '../publish/review.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { commitWorkflowState } from '../state-ops/commit.js';
import { readWorkflowStateHead, rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { MAX_STATE_CONFLICT_RETRIES, stateOpsError } from '../state-ops/errors.js';
import { rejectRunSnapshot } from '../../snapshots/run/lifecycle.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import { APPLY_UNFINISHED_REFUSAL } from '../../../core/runtime/commands/messages.js';
import { stagedWorkspaceRoot } from '../isolation/retention.js';
import { removeClosedRunWorkspace } from '../isolation/closed-runs.js';
import { removeSandboxTempDirs } from '../../runners/sandbox/state/paths.js';

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

export async function closeRunIfOpen(
  scope: SessionRef & { bus?: EventBus | undefined },
  state: WorkflowState,
  as?: 'discarded',
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const warn = (message: string, phase: WorkflowState['phase']): void => {
    if (scope.bus !== undefined) publishWarning({ bus: scope.bus, phase, message });
  };
  let workspaceForClosure: WorkflowState['workspace'];
  let workspaceToRemove: NonNullable<WorkflowState['workspace']> | undefined;
  let patchHandled = false;
  let patch: string | undefined;
  let warning: string | undefined;

  for (let attempt = 0; ; attempt += 1) {
    // A run stopped before it ever saved a state still closes: the close then
    // creates the head instead of failing the CAS against a file that is not there.
    const head = readWorkflowStateHead(scope);
    const latest = head === null ? state : rebaseOnPersistedWorkflowState(scope, state);
    const status = deriveRunStatus({ state: latest, liveness: 'not-alive', reviewNone: false });
    if (status.kind === 'closed') {
      return { state: latest, closedNow: false };
    }
    assertCanCloseRun(latest);

    if (!patchHandled) {
      patchHandled = true;
      const workspace = latest.workspace;
      workspaceForClosure = workspace;
      if (workspace !== undefined && workspace.kind !== 'checkout') {
        let resolvedWorkspace = workspace;
        if (!existsSync(workspace.path) && workspace.kind === 'staged-copy') {
          const leaf = basename(dirname(workspace.path));
          if (StagedWorkspaceLeafSchema.safeParse(leaf).success) {
            const permittedPath = join(stagedWorkspaceRoot(scope, leaf), 'workspace');
            if (existsSync(permittedPath)) {
              resolvedWorkspace = { ...workspace, path: permittedPath };
            }
          }
        }
        workspaceForClosure = resolvedWorkspace;
        workspaceToRemove = resolvedWorkspace;
        if (existsSync(resolvedWorkspace.path)) {
          const patchPath = await writeRunPatch(scope, resolvedWorkspace);
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
      await persistStoppedBriefEvidence(scope, latest, workspaceForClosure);
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
        // After a project move, the temp folders of the workspace still carry the recorded path.
        if (latest.workspace !== undefined && latest.workspace.path !== workspaceToRemove.path)
          removeSandboxTempDirs(latest.workspace.path);
      }
      return { state: result.state, closedNow: true };
    }
    if (result.kind === 'durability-uncertain')
      throw stateOpsError.durabilityUncertain(scope.sessionId);
    if (attempt === MAX_STATE_CONFLICT_RETRIES) {
      throw stateOpsError.conflictExhausted(scope.sessionId, {
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
