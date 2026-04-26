import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Task } from '../../core/schemas/task.js';
import type { OrchestratorCallbacks } from './types.js';
import type { EventBus } from '../events/types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Config } from '../../core/schemas/config.js';
import { saveState } from '../../core/state/persistence.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, REVIEW_FILE } from '../../core/paths.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { getCurrentDiff, discardTaskChanges, getChangedFiles } from '../../lib/git.js';
import { labelError } from '../../utils/format-errors.js';
import { warnError } from '../../lib/warn.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';
import { readEvidenceLedger, recordFinalReviewEvidence, writeEvidenceLedger } from './evidence.js';
import { analyzeBriefDrift, formatDriftReportForPrompt, publishDriftReport, writeDriftReport } from './drift.js';

import type { Planner } from '../planners/types.js';
import { buildSummary, type SummaryBase } from './summary.js';
import { publishEvent, publishError, publishPlannerStatus, publishWarning } from './events.js';
import { transitionAndSave } from './state-ops.js';
import { runPlannerReview } from './planner-review.js';
import { createSnapshot } from '../snapshots/store.js';

export async function runFinalReviewPhase(
  opts: { projectDir: string; sessionId: string; config: Config; callbacks: OrchestratorCallbacks; bus: EventBus; state: WorkflowState; planner: Planner; metadata?: SpecMetadata | null },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
  phaseTimings?: Record<string, number>,
): Promise<Summary> {
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, bus, planner, metadata } = opts;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'ALL_DONE' });

  if (config.snapshots?.auto?.preFinalReview === true) {
    try {
      await createSnapshot({
        projectDir,
        sessionId,
        phase: 'manual',
        name: 'pre-final-review',
        bus,
        eventPhase: state.phase,
      });
    } catch (err) {
      publishWarning(bus, state.phase, labelError('auto-snapshot (pre-final-review) failed', err));
    }
  }

  const finalReviewStart = Date.now();
  publishPlannerStatus(bus, state, 'running');
  publishEvent(bus, { type: 'all_tasks_done', ts: Date.now(), phase: state.phase });

  let reviewStatus: 'written' | 'failed' = 'written';
  try {
    const diff = await getCurrentDiff(projectDir);
    const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);

    let driftPromptSection: string | undefined;
    try {
      const changedFiles = await getChangedFiles(projectDir);
      const ledger = readEvidenceLedger(projectDir, sessionId);
      const driftReport = analyzeBriefDrift({ tasks: state.tasks, changedFiles, diff, ledger });
      writeDriftReport(projectDir, sessionId, driftReport);
      publishDriftReport(bus, state.phase, driftReport);
      driftPromptSection = formatDriftReportForPrompt(driftReport);
    } catch (err) {
      warnError('Failed to compute drift report', err);
    }

    const review = await runPlannerReview({
      planner,
      prompt: buildFinalReviewPrompt(spec, diff, driftPromptSection),
      projectDir,
      sessionId,
      bus,
      state,
      metadata,
      writeTo: REVIEW_FILE,
    });
    state = review.state;
  } catch (err) {
    publishError(bus, state.phase, labelError('Final review failed', err));
    reviewStatus = 'failed';
  }

  try {
    const ledger = readEvidenceLedger(projectDir, sessionId);
    if (ledger) {
      writeEvidenceLedger(projectDir, sessionId, recordFinalReviewEvidence({ ledger, status: reviewStatus }));
    }
  } catch (err) {
    warnError('Failed to record final review evidence', err);
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'REVIEW_DONE' });
  publishPlannerStatus(bus, state, 'done', { duration: Date.now() - finalReviewStart });
  publishEvent(bus, { type: 'workflow_complete', ts: Date.now(), phase: state.phase });

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
