import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { CostPrediction, Summary } from '../../../core/schemas/summary.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishCostPrediction, publishError, publishWarning } from '../events.js';
import { decideCostGate } from '../cost-gate.js';
import { predictCost } from '../budget/cost-prediction.js';
import { estimateDeterministicCost } from '../budget/estimate.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { decideReviewOutcome } from '../review-fix.js';
import { REVIEW_CYCLE_CAP } from '../../../core/pipeline-spec/review.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';
import { PLAN_FILE, REVIEW_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type { PlanningPhaseResult } from '../planning/types.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'files' | 'action'> | undefined) => void;
};

export const APPROVAL_PARKED_ARTIFACT: Partial<Record<Phase, string>> = {
  'reviewing-spec': SPEC_FILE,
  'reviewing-plan': PLAN_FILE,
  'reviewing-briefs': TASKS_FILE,
};

function predictTasksCost(opts: {
  tasks: Task[];
  summaryBase: SummaryBase;
  wctx: WorkflowContext;
  state: WorkflowState;
}): CostPrediction {
  return {
    ...predictCost({
      taskCount: opts.tasks.length,
      plannerTool: opts.summaryBase.plannerTool,
      implementerTool: opts.summaryBase.implementerTool,
      plannerModel: opts.summaryBase.plannerModel,
      implementerModel: opts.summaryBase.implementerModel,
      tokenUsage: opts.state.tokenUsage,
      cache: opts.wctx.modelCache,
      config: opts.wctx.config,
    }),
    deterministic: estimateDeterministicCost({
      tasks: opts.tasks,
      context: opts.wctx.context,
      config: opts.wctx.config,
      pricingCache: opts.wctx.modelCache,
      languageContext: buildProjectLanguageContext(
        opts.wctx.projectDir,
        opts.state.discoveredValidation?.language,
      ),
      ...(opts.wctx.detectedContextLength !== undefined && {
        detectedContextLength: opts.wctx.detectedContextLength,
      }),
    }),
  };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; cancelled: boolean; state: WorkflowState }> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state, phaseTimings }),
    completed: false,
    cancelled: false,
    state,
  });

  if (opts.planning.disposition !== 'ready-for-tasks') {
    return bail();
  }

  // On resume the task loop continues from currentTaskIndex, so the pre-task cost
  // gauntlet must predict over the remaining tasks only and must not re-gate work
  // that is already in flight.
  const isResume = state.currentTaskIndex > 0;
  const gateTasks = isResume ? state.tasks.slice(state.currentTaskIndex) : state.tasks;

  if (gateTasks.length > 0) {
    const prediction: CostPrediction = predictTasksCost({
      tasks: gateTasks,
      summaryBase,
      wctx,
      state,
    });
    publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);

    if (!isResume) {
      const gateDecision = decideCostGate({
        mode: state.mode ?? wctx.config.workflow?.mode,
        prediction,
        costGateEnabled: wctx.config.workflow.costGate !== false,
      });
      if (gateDecision === 'skip-unknown-cost') {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: 'cost gate skipped: implementer pricing unknown',
        });
      }
      if (gateDecision === 'gate' && wctx.callbacks.onCostApprovalNeeded) {
        const approved = await wctx.callbacks.onCostApprovalNeeded(prediction);
        if (!approved) {
          return bail();
        }
      }
    }

    summaryBase = { ...summaryBase, costPrediction: prediction };
  }

  await ensureRunBaselineSnapshot({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const phaseStart = Date.now();
  const taskResult = await runTaskLoop({
    wctx,
    initialState: state,
    setTrackedState,
    setCurrentTask,
  });
  state = taskResult.state;

  phaseTimings.implementing = Date.now() - phaseStart;

  if (wctx.signal?.aborted) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: false,
      state,
    };
  }

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview = state.phase === 'implementing' || state.phase === 'final-review';
  if (taskResult.status !== 'complete' || !canRunFinalReview) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: taskResult.status === 'cancelled',
      state,
    };
  }

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let taskBreakdowns = taskResult.taskBreakdowns;
  const summaryNow = () => buildSummary({ ...summaryBase, state, taskBreakdowns, phaseTimings });

  // The review owns the run's exit: a `fail` it can attribute to briefs sends
  // those briefs back through implementation and asks again, up to the cap.
  for (let cycle = 0; ; cycle++) {
    const review = await runFinalReviewPhase({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      config: wctx.config,
      callbacks,
      bus: wctx.bus,
      state,
      reviewer: wctx.reviewer,
      metadata: wctx.metadata,
      signal: wctx.signal,
      sinks: wctx.sinks,
      summaryBase,
      taskBreakdowns,
      phaseTimings,
    });
    state = review.state;
    if (wctx.signal?.aborted) {
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    const decision = decideReviewOutcome(review, state.tasks, REVIEW_CYCLE_CAP, cycle);
    if (decision.kind === 'pass') {
      state = transitionAndSave(ref, state, { type: 'REVIEW_DONE', reviewStatus: 'passed' });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'passed',
      });
      const summary = summaryNow();
      callbacks.onComplete(summary);
      return { summary, completed: true, cancelled: false, state };
    }

    if (decision.kind === 'fail') {
      state = transitionAndSave(ref, state, { type: 'REVIEW_DONE', reviewStatus: 'failed' });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'failed',
        blocking: decision.blocking,
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: `Final review failed with ${decision.blocking} blocking finding${decision.blocking === 1 ? '' : 's'}; see ${REVIEW_FILE}`,
        safety: { category: 'recovery', code: 'review_failed' },
      });
      state = raisePendingRecovery(
        { ...ref, bus: wctx.bus },
        state,
        buildReviewFailedRecoveryIssue({
          blocking: decision.blocking,
          phase: state.phase,
          createdAt: nowIso(),
        }),
        setTrackedState,
      );
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    state = transitionAndSave(ref, state, {
      type: 'REVIEW_FIX_START',
      fixes: decision.fixes,
      cycle: cycle + 1,
    });
    setTrackedState(state);
    wctx.bus.publish({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: state.phase,
      cycle,
      taskIds: state.tasks.filter((t) => decision.fixes[t.id] !== undefined).map((t) => t.id),
    });

    const rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    taskBreakdowns = rerun.taskBreakdowns;
    if (rerun.status !== 'complete') {
      return {
        summary: summaryNow(),
        completed: false,
        cancelled: rerun.status === 'cancelled',
        state,
      };
    }
  }
}
