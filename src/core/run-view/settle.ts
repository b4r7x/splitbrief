import type { WorkflowState } from '../schemas/workflow.js';
import { reopensPlanCard, resumeStep } from '../sessions/run-status.js';
import { briefPosition } from '../state/selectors.js';
import type { RunBriefs, WorkflowTask } from './briefs.js';
import type { RunHalt } from './halt.js';
import { EMPTY_RUN_VIEW, type RunView } from './reduce.js';

/**
 * The saved state laid over the folded log. Every step saves the state before it publishes its
 * event, so a run whose process went away between the two has a log one step behind; the state
 * wins on the facts it holds: the phase, the halt, the brief list, what the run asks and why it
 * stopped. A log written before its events named these facts reads them from the state too.
 */
export function settleRunView(view: RunView, state: WorkflowState): RunView {
  const asked = state.pendingPlannerConversation;
  return {
    ...view,
    phase: state.phase,
    halt: settleHalt(state),
    briefs: settleBriefs(view.briefs, state),
    questions: asked === undefined || asked.answered ? null : asked.questions,
    planCard: reopensPlanCard(state),
    stopKept: state.interruptedStep?.kept ?? EMPTY_RUN_VIEW.stopKept,
    failure: state.lastFailure?.message ?? null,
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
