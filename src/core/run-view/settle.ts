import type { WorkflowState } from '../schemas/workflow.js';
import type { RunView } from './reduce.js';

/**
 * The saved state laid over the folded log. Every step saves the state before it publishes its
 * event, so a run whose process went away between the two has a log one step behind; the state
 * wins on the facts it holds.
 */
export function settleRunView(view: RunView, state: WorkflowState): RunView {
  return state.phase === view.phase ? view : { ...view, phase: state.phase };
}
