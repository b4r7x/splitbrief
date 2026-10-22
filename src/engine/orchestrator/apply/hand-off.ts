import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { transitionAndSave } from '../state-ops.js';
import type { ApplyConflict } from './merge.js';
import { entryKey } from './states.js';

/** The conflicted files Apply hands to the workspace, with the checkout entry it saw for each. */
export function handOff(state: WorkflowState, conflicts: readonly ApplyConflict[]): WorkflowState {
  return transition(state, {
    type: 'RECORD_APPLY_INTEGRATED',
    integrated: conflicts.map((conflict) => ({
      path: conflict.path,
      checkout: entryKey(conflict.theirs),
      workspace: null,
    })),
  });
}

/**
 * Binds each handed-off file to the workspace entry the user resolved it to. Re-run Apply takes
 * the resolution of a halt; the first review after the marker fix takes the resolution of the
 * conflict markers, never the review that still has the Apply conflict open.
 */
export function bindApplyHandOffs(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
  candidate: Record<string, string>,
): WorkflowState {
  if (
    state.applyIntegrated?.some((record) => record.workspace === null) !== true ||
    state.pendingTriage?.inputs.some((input) => input.source === 'apply') === true
  ) {
    return state;
  }
  return transitionAndSave(ref, state, { type: 'BIND_APPLY_INTEGRATED', candidate });
}
