import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowContext, WorkflowPersistenceContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';

import { buildSummary, type SummaryBase } from '../summary.js';
import { publishCostPrediction, publishWarning } from '../events.js';
import { decideCostGate } from '../cost-gate.js';
import { predictCost } from '../budget/cost-prediction.js';
import { estimateDeterministicCost } from '../budget/estimate.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { reviewPlannerEstimate, runningPlannerEstimateReview } from '../estimate-review/run.js';
import { autoSplitOverflowTasks } from '../auto-split-overflow.js';
import { runPlanningPhase } from '../planning/run.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { transitionAndSave } from '../state-ops.js';
import { formatSkippedSplitNotice, reviewAutoSplitOutput } from './auto-split-review.js';

export function applyPostPlanDrain(opts: {
  ctx: WorkflowPersistenceContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
}): WorkflowState {
  // Post-plan has no planner consumer; leave queued messages for final-review/task drains.
  void opts;
  return opts.state;
}

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
};

function isInterruptedPlanningTurn(state: WorkflowState): boolean {
  return (
    state.awaitingContinue &&
    (state.phase === 'researching' || state.phase === 'specifying' || state.phase === 'planning')
  );
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, savedState, selectedSkills, phaseTimings, startTime, setTrackedState } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  const interrupted = isInterruptedPlanningTurn(state);
  const shouldRunPlanning = !savedState || Boolean(savedState.rewindPending) || interrupted;

  if (interrupted) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CONTINUE_TURN' });
    setTrackedState(state);
  }

  if (shouldRunPlanning) {
    const plannerFeature = wctx.plannerContext
      ? `${state.feature}\n\n<user-context>\n${wctx.plannerContext}\n</user-context>`
      : state.feature;
    const planning = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus: wctx.bus,
        signal: wctx.signal,
        metadata: wctx.metadata,
        sinks: wctx.sinks,
        drainPendingAttachments: wctx.drainPendingAttachments,
      },
      planner,
      state,
      feature: plannerFeature,
      selectedSkills,
      rewindPending: savedState?.rewindPending,
    });
    state = planning.state;
    setTrackedState(state);
    phaseTimings.planning = Date.now() - startTime;
    if (planning.cancelled) return { state, cancelled: true };
  }

  return { state, cancelled: false };
}

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
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
    }),
    ...(opts.plannerEstimateReview !== undefined && {
      plannerEstimateReview: opts.plannerEstimateReview,
    }),
  };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean }> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;

  if (state.tasks.length > 0) {
    let prediction: CostPrediction = predictTasksCost({
      tasks: state.tasks,
      summaryBase,
      wctx,
      state,
    });
    if (wctx.config.plannerEstimateReview) {
      prediction.plannerEstimateReview = runningPlannerEstimateReview();
    }
    publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);

    const gateDecision = decideCostGate({
      mode: wctx.config.workflow?.mode,
      prediction,
      costGateEnabled: wctx.config.workflow.costGate !== false,
    });
    if (gateDecision === 'gate' && wctx.callbacks.onCostApprovalNeeded) {
      const approved = await wctx.callbacks.onCostApprovalNeeded(prediction);
      if (!approved) {
        return {
          summary: buildSummary({ ...summaryBase, state, phaseTimings }),
          completed: false,
        };
      }
    }

    if (wctx.config.plannerEstimateReview && prediction.deterministic) {
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
      prediction = { ...prediction, plannerEstimateReview: reviewed.review };
      publishCostPrediction({ bus: wctx.bus, phase: state.phase }, prediction);
    }

    if (prediction.deterministic) {
      const split = autoSplitOverflowTasks({
        enabled: wctx.config.autoSplitOverflow,
        tasks: state.tasks,
        estimate: prediction.deterministic,
        plannerReview: prediction.plannerEstimateReview,
      });
      if (split.skippedSplits.length > 0) {
        publishWarning(
          { bus: wctx.bus, phase: state.phase },
          formatSkippedSplitNotice(split.skippedSplits),
        );
      }
      if (split.changed) {
        const reviewed = await reviewAutoSplitOutput({
          wctx,
          state,
          tasks: split.tasks,
          setTrackedState,
        });
        state = reviewed.state;
        if (!reviewed.approved) {
          return {
            summary: buildSummary({ ...summaryBase, state, phaseTimings }),
            completed: false,
          };
        }
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
    };
  }

  const finalReview = await runFinalReviewPhase(
    {
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      config: wctx.config,
      callbacks,
      bus: wctx.bus,
      state,
      planner: wctx.planner,
      metadata: wctx.metadata,
      signal: wctx.signal,
      sinks: wctx.sinks,
    },
    summaryBase,
    taskResult.taskBreakdowns,
    phaseTimings,
  );
  return {
    summary: finalReview.summary,
    completed: !wctx.signal?.aborted && finalReview.state.phase === 'complete',
  };
}
