import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { EventBus } from '../../events/types.js';
import { writeRunPatch } from '../apply/patch.js';
import { publishWarning } from '../events.js';
import { removeRunWorkspace } from '../isolation/remove-worktree.js';
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

  for (let attempt = 0; ; attempt += 1) {
    // A run stopped before it ever saved a state still closes: the close then
    // creates the head instead of failing the CAS against a file that is not there.
    const head = readWorkflowStateHead(scope);
    const latest = head === null ? state : rebaseOnPersistedWorkflowState(scope, state);
    const status = deriveRunStatus({ state: latest, liveness: 'not-alive' });
    if (status.kind === 'closed') {
      return { state: latest, closedNow: false };
    }

    if (!patchHandled) {
      patchHandled = true;
      const workspace = latest.workspace;
      if (workspace?.kind === 'checkout') {
        warn(
          'This run edited your checkout directly: its changes are already there, so nothing is unapplied and no run patch was written.',
          latest.phase,
        );
      } else if (workspace !== undefined) {
        workspaceToRemove = workspace;
        if (existsSync(workspace.path)) {
          const patchPath = await writeRunPatch(scope, workspace);
          warn(
            `Run changes not applied are saved in ${relative(scope.projectDir, patchPath)}; apply them with git apply.`,
            latest.phase,
          );
        } else {
          warn(
            `The run workspace at ${workspace.path} is gone; no run patch was written.`,
            latest.phase,
          );
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
      }),
    });
    if (result.kind === 'committed') {
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
