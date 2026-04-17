import type { WorkflowState, Task } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { TaskTokenUsage, Summary } from '../../core/types/summary.js';
import { saveState } from '../../core/state/persistence.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, REVIEW_FILE } from '../../core/paths.js';
import { killAllProcesses } from '../../utils/process-registry.js';
import { getCurrentDiff } from '../../utils/git.js';
import { discardTaskChanges } from './git-ops.js';
import { labelError } from '../../utils/format-errors.js';
import { warnError } from '../../utils/warn.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';

import type { Planner } from '../planners/types.js';
import { buildSummary, type SummaryBase } from './summary.js';
import { emit, emitError, emitPlannerStatus } from './events.js';
import { transitionAndSave, runPlannerReview } from './helpers.js';

export async function runFinalReviewPhase(
  opts: { projectDir: string; sessionId: string; callbacks: OrchestratorCallbacks; state: WorkflowState; planner: Planner; metadata?: SpecMetadata | null },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
  phaseTimings?: Record<string, number>,
): Promise<Summary> {
  let { state } = opts;
  const { projectDir, sessionId, callbacks, planner, metadata } = opts;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'ALL_DONE' });
  const finalReviewStart = Date.now();
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, sessionId, state, 'all_tasks_done', undefined, {});

  try {
    const diff = await getCurrentDiff(projectDir);
    const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
    const review = await runPlannerReview({
      planner,
      prompt: buildFinalReviewPrompt(spec, diff),
      projectDir,
      sessionId,
      callbacks,
      state,
      metadata,
      writeTo: REVIEW_FILE,
    });
    state = review.state;
  } catch (err) {
    emitError(callbacks, labelError('Final review failed', err));
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'REVIEW_DONE' });
  emitPlannerStatus(callbacks, state, 'done', { duration: Date.now() - finalReviewStart });
  emit(projectDir, sessionId, state, 'workflow_complete', undefined, {});

  if (phaseTimings) {
    phaseTimings.review = Date.now() - finalReviewStart;
  }

  const summary = buildSummary({ ...summaryBase, state, taskBreakdowns, ...(phaseTimings && { phaseTimings }) });
  callbacks.onComplete(summary);
  return summary;
}

export function shutdownWorkflow(
  projectDir: string,
  sessionId: string,
  getTrackedState: () => WorkflowState | undefined,
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined,
): void {
  killAllProcesses();
  const trackedState = getTrackedState();
  if (trackedState) {
    try { saveState(projectDir, sessionId, trackedState); } catch (err) {
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
