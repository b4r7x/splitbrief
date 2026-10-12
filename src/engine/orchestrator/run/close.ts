import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error, matches } from '../../../utils/error.js';
import type { EventBus } from '../../events/types.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../events/workflow-cancel.js';
import { writeRunPatch } from '../apply/patch.js';
import {
  publishRecoveryActionSelected,
  publishRecoveryResolved,
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
} from '../state-ops.js';

export function filesStillOnDiskSuffix(workspace: WorkflowState['workspace']): string {
  return workspace === undefined || workspace.kind === 'checkout'
    ? ' The files it wrote are still on disk.'
    : '';
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
      if (workspace?.kind === 'checkout') {
        warning =
          'This run edited your checkout directly: its changes are already there, so nothing is unapplied and no run patch was written.';
      } else if (workspace !== undefined) {
        workspaceToRemove = workspace;
        if (existsSync(workspace.path)) {
          patch = relative(scope.projectDir, await writeRunPatch(scope, workspace));
          warning = `Run changes not applied are saved in ${patch}; apply them with git apply.`;
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
      if (warning !== undefined) warn(warning, result.state.phase);
      if (workspaceToRemove !== undefined) {
        await removeClosedRunWorkspace(scope, workspaceToRemove, result.state.phase);
      }
      return { state: result.state, closedNow: true };
    }
    if (result.kind === 'durability-uncertain') throw stateOpsError.durabilityUncertain();
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

export const endRunError = {
  applying: () =>
    error(
      'end-run-while-applying',
      'Apply did not finish. Restore or retry Apply first, then end the run.',
    ),
  isApplying: matches('end-run-while-applying'),
};

export function assertCanCloseRun(state: WorkflowState): void {
  if (state.applying !== undefined) throw endRunError.applying();
}

export async function endRun(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
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
    scope.bus.publish({
      type: 'workflow_cancelled',
      ts: Date.now(),
      phase: closure.state.phase,
      reason: WORKFLOW_CANCEL_REASON_USER,
    });
  }
  return closure;
}

export async function endRunAtRest(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
  config: Config,
): Promise<{ state: WorkflowState; closedNow: boolean }> {
  const closure = await endRun(scope, state);
  finalizeRunAtRest({ ref: scope, config, state: closure.state });
  return closure;
}
