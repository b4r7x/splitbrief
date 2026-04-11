import type { OrchestratorCallbacks, WorkflowState, TaskTokenUsage, Summary, Task } from '../../types.js';
import { saveState } from '../../core/state/persistence.js';
import { readSpecFileOrEmpty } from '../../core/paths-io.js';
import { SPEC_FILE, REVIEW_FILE } from '../../core/paths.js';
import { killAllProcesses } from '../../utils/process.js';
import { getCurrentDiff } from '../../utils/git.js';
import { discardTaskChanges } from './git-ops.js';
import { toErrorMessage, warnError } from '../../utils/format.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';

import type { Planner } from '../planners/types.js';
import { buildSummary, type SummaryBase } from './cost.js';
import { emit, emitError, emitPlannerStatus } from './events.js';
import { transitionAndSave, runPlannerReview } from './helpers.js';

export async function runFinalReviewPhase(
  opts: { projectDir: string; callbacks: OrchestratorCallbacks; state: WorkflowState; planner: Planner },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
  phaseTimings?: Record<string, number>,
): Promise<Summary> {
  let { state } = opts;
  const { projectDir, callbacks, planner } = opts;

  state = transitionAndSave(projectDir, state, { type: 'ALL_DONE' });
  const finalReviewStart = Date.now();
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, state, 'all_tasks_done', undefined, {});

  try {
    const diff = await getCurrentDiff(projectDir);
    const spec = readSpecFileOrEmpty(projectDir, SPEC_FILE);
    const review = await runPlannerReview({
      planner,
      prompt: buildFinalReviewPrompt(spec, diff),
      projectDir,
      callbacks,
      state,
      writeTo: REVIEW_FILE,
    });
    state = review.state;
  } catch (err) {
    emitError(callbacks, `Final review failed: ${toErrorMessage(err)}`);
  }

  state = transitionAndSave(projectDir, state, { type: 'REVIEW_DONE' });
  emitPlannerStatus(callbacks, state, 'done', { duration: Date.now() - finalReviewStart });
  emit(projectDir, state, 'workflow_complete', undefined, {});

  if (phaseTimings) {
    phaseTimings.review = Date.now() - finalReviewStart;
  }

  const summary = buildSummary({ ...summaryBase, state, taskBreakdowns, ...(phaseTimings && { phaseTimings }) });
  callbacks.onComplete(summary);
  return summary;
}

export function shutdownWorkflow(
  projectDir: string,
  getTrackedState: () => WorkflowState | undefined,
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined,
): void {
  killAllProcesses();
  const trackedState = getTrackedState();
  if (trackedState) {
    try { saveState(projectDir, trackedState); } catch (err) {
      warnError('Failed to save state during shutdown', err);
    }
  }
  const currentTask = getCurrentTask();
  if (currentTask) {
    try { discardTaskChanges(projectDir, currentTask.file, currentTask.action); } catch (err) {
      warnError('Failed to discard changes during shutdown', err);
    }
  }
}
