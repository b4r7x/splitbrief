import type { WorkflowState } from '../schemas/workflow/state.js';
import { afterLastBrief, reopensPlanCard, resumeStep } from '../sessions/run/status.js';
import { briefPosition } from '../state/selectors.js';
import type { RunBriefs, WorkflowTask } from './briefs.js';
import type { RunHalt } from './halt.js';
import { EMPTY_RUN_VIEW, type RunView } from './reduce.js';

/**
 * The saved state laid over the folded log. Every step saves the state before it publishes its
 * event, so a run whose process went away between the two has a log one step behind; the state
 * wins on the facts it holds: the phase, the halt, the brief list, what the run asks and why it
 * stopped. A log written before its events named these facts reads them from the state too.
 * `reviewNone` is REVIEW None in the config the next pass runs on: the log names the last pass's.
 */
export function settleRunView(view: RunView, state: WorkflowState, reviewNone: boolean): RunView {
  const asked = state.pendingPlannerConversation;
  return {
    ...settleReviewNone(view, state, reviewNone),
    phase: state.phase,
    briefs: settleBriefs(view.briefs, state),
    questions: asked === undefined || asked.answered ? null : asked.questions,
    planCard: reopensPlanCard(state),
    stopKept: state.interruptedStep?.kept ?? EMPTY_RUN_VIEW.stopKept,
    failure: state.lastFailure?.message ?? null,
    passSeats: savedPassSeats(state),
  };
}

/** The saved state keeps no axis words, so the chrome does not take these seats as known. */
function savedPassSeats(state: WorkflowState): RunView['passSeats'] {
  if (!state.plannerTool || !state.implementerTool) return null;
  return {
    plannerTool: state.plannerTool,
    implementerTool: state.implementerTool,
    plannerModel: state.plannerModel,
    implementerModel: state.implementerModel,
    ...(state.reviewerTool !== undefined && {
      reviewerTool: state.reviewerTool,
      ...(state.reviewerModel !== undefined && { reviewerModel: state.reviewerModel }),
    }),
    ...(state.reviewerSeat !== undefined && { reviewerSeat: state.reviewerSeat }),
  };
}

/** What REVIEW None decides on the view: a move of REVIEW at a waiting halt changes this alone. */
export function settleReviewNone(
  view: RunView,
  state: WorkflowState,
  reviewNone: boolean,
): RunView {
  return {
    ...view,
    halt: settleHalt(state, reviewNone),
    reviewNone,
    afterLastBrief: afterLastBrief(state, reviewNone, 0),
  };
}

/** The halt the run status names: a saved halt is pending until the run answers it. */
function settleHalt(state: WorkflowState, reviewNone: boolean): RunHalt | null {
  return state.pendingRecovery === undefined
    ? null
    : { issue: state.pendingRecovery, at: resumeStep(state, reviewNone) };
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
