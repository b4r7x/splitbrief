import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { CostPrediction, Summary } from '../../../core/schemas/summary.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowContext } from '../types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishCostPrediction, publishWarning } from '../events.js';
import { decideCostGate } from '../cost-gate.js';
import { predictCost } from '../budget/cost-prediction.js';
import { estimateDeterministicCost } from '../budget/estimate.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { reviewPlannerEstimate, runningPlannerEstimateReview } from '../estimate-review/run.js';
import { autoSplitOverflowTasks } from '../auto-split-overflow.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { formatSkippedSplitNotice, reviewAutoSplitOutput } from './auto-split-review.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type { PhaseRecoveryBinding } from './phases.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import {
  matchesPersistedExecutionPermit,
  revalidatePersistedExecutionPermit,
} from '../planning/handoff.js';
import { workflowAuthority } from './authority.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
  recovery?: PhaseRecoveryBinding | undefined;
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
  plannerEstimateReview?: CostPrediction['plannerEstimateReview'] | undefined;
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
    ...(opts.plannerEstimateReview !== undefined && {
      plannerEstimateReview: opts.plannerEstimateReview,
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

  const planning = opts.planning;
  if (
    planning.disposition !== 'ready-for-tasks' ||
    !matchesPersistedExecutionPermit(planning, state)
  ) {
    return bail();
  }

  const authority = workflowAuthority(wctx);
  if (authority === undefined) {
    return bail();
  }

  const revalidated = revalidatePersistedExecutionPermit({
    ref: { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    state,
    planning,
    authority,
  });
  if (revalidated === null) {
    return bail();
  }
  state = revalidated.state;
  let handoff = revalidated.planning;
  setTrackedState(state);

  // On resume the task loop continues from currentTaskIndex, so the pre-task cost
  // gauntlet must predict over the remaining tasks only and must not re-gate, re-run
  // the paid estimate review, or auto-split work that is already in flight.
  const isResume = state.currentTaskIndex > 0;
  const gateTasks = isResume ? state.tasks.slice(state.currentTaskIndex) : state.tasks;

  if (gateTasks.length > 0) {
    let prediction: CostPrediction = predictTasksCost({
      tasks: gateTasks,
      summaryBase,
      wctx,
      state,
    });
    if (wctx.config.plannerEstimateReview && !isResume) {
      prediction.plannerEstimateReview = runningPlannerEstimateReview();
    }
    publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);

    // The estimate review is an extra paid planner call whose output recommends a user
    // decision, so it must finish before the cost gate it informs: its classification and
    // recommendedUserDecision ride along in the prediction handed to onCostApprovalNeeded.
    if (!isResume && wctx.config.plannerEstimateReview && prediction.deterministic) {
      const reviewed = await reviewPlannerEstimate({
        planner: wctx.planner,
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
        bus: wctx.bus,
        state,
        config: wctx.config,
        estimate: prediction.deterministic,
        metadata: wctx.metadata,
        forcedProfileId: wctx.implementerProfile,
        signal: wctx.signal,
      });
      state = reviewed.state;
      setTrackedState(state);
      handoff = { ...handoff, state };
      prediction = { ...prediction, plannerEstimateReview: reviewed.review };
      publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);
    }

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

    if (!isResume && prediction.deterministic) {
      const split = autoSplitOverflowTasks({
        enabled: wctx.config.autoSplitOverflow,
        tasks: state.tasks,
        estimate: prediction.deterministic,
        plannerReview: prediction.plannerEstimateReview,
      });
      if (split.skippedSplits.length > 0) {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: formatSkippedSplitNotice(split.skippedSplits),
        });
      }
      if (split.changed) {
        if (opts.recovery?.createAdmissionInput === undefined) {
          publishWarning({
            bus: wctx.bus,
            phase: state.phase,
            message: 'Auto-split output remains in review because Brief recovery is unavailable.',
            safety: {
              category: 'workflow',
              code: 'brief_recovery_unavailable',
              transcriptSafe: true,
            },
          });
          return bail();
        }
        const reviewed = await reviewAutoSplitOutput({
          wctx,
          state,
          tasks: split.tasks,
          setTrackedState,
          recovery: opts.recovery,
        });
        state = reviewed.state;
        if (reviewed.disposition !== 'ready-for-tasks') {
          return bail();
        }
        handoff = reviewed;
        prediction = predictTasksCost({
          tasks: state.tasks,
          summaryBase,
          wctx,
          state,
          plannerEstimateReview: prediction.plannerEstimateReview,
        });
        publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);
      }
    }
    summaryBase = { ...summaryBase, costPrediction: prediction };
  }

  const finalAuthority = workflowAuthority(wctx);
  if (finalAuthority === undefined) {
    return bail();
  }
  const finalRevalidated = revalidatePersistedExecutionPermit({
    ref: { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    state,
    planning: handoff,
    authority: finalAuthority,
  });
  if (finalRevalidated === null) {
    return bail();
  }
  state = finalRevalidated.state;
  setTrackedState(state);

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

  const finalReview = await runFinalReviewPhase({
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
    taskBreakdowns: taskResult.taskBreakdowns,
    phaseTimings,
  });
  return {
    summary: finalReview.summary,
    completed: !wctx.signal?.aborted && finalReview.state.phase === 'complete',
    cancelled: false,
    state: finalReview.state,
  };
}
