import type { WorkflowState } from '../schemas/workflow.js';
import { resumeStep } from '../sessions/run-status.js';
import { briefPosition } from '../state/selectors.js';
import type { RunBriefs, WorkflowTask } from './briefs.js';
import type { RunHalt } from './halt.js';
import type { RunView } from './reduce.js';

/**
 * The saved state laid over the folded log. Every step saves the state before it publishes its
 * event, so a run whose process went away between the two has a log one step behind; the state
 * wins on the facts it holds: the phase, the halt and the brief list.
 */
export function settleRunView(view: RunView, state: WorkflowState): RunView {
  return {
    ...view,
    phase: state.phase,
    halt: settleHalt(state),
    briefs: settleBriefs(view.briefs, state),
  };
}

/** The halt the run status names: a saved halt is pending until the run answers it. */
function settleHalt(state: WorkflowState): RunHalt | null {
  return state.pendingRecovery === undefined
    ? null
    : { issue: state.pendingRecovery, at: resumeStep(state) };
}

function settleBriefs(briefs: RunBriefs, state: WorkflowState): RunBriefs {
  const tasks = state.tasks.map<WorkflowTask>((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    file: task.suggestedFiles[0],
    action: task.action,
  }));
  return {
    ...briefs,
    tasks,
    taskMap: new Map(tasks.map((task) => [task.id, task])),
    currentTask: briefPosition(state)?.position ?? 0,
    totalTasks: state.tasks.length,
  };
}
