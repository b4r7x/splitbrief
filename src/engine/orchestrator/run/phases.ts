import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowContext, PlannerCallbacksContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EngineEvent } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Planner } from '../../planners/types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishCostPrediction, publishWarning } from '../events.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { decideCostGate } from '../cost-gate.js';
import { predictCost } from '../budget/cost-prediction.js';
import { estimateDeterministicCost } from '../budget/estimate.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { reviewPlannerEstimate, runningPlannerEstimateReview } from '../estimate-review/run.js';
import { autoSplitOverflowTasks } from '../auto-split-overflow.js';
import { runPlanningPhase } from '../planning/run.js';
import { resumeBriefsApproval } from '../planning/resume-briefs.js';
import { resumeArtifactApproval } from '../planning/resume-artifact-approval.js';
import { regeneratePlanAndTasks, regenerateTasksIfNeeded } from '../planning/regen.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { transitionAndSave } from '../state-ops.js';
import { formatSkippedSplitNotice, reviewAutoSplitOutput } from './auto-split-review.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
  rewindFeedback?: string | undefined;
};

function isInterruptedPlanningTurn(state: WorkflowState): boolean {
  return (
    state.awaitingContinue &&
    (state.phase === 'researching' || state.phase === 'specifying' || state.phase === 'planning')
  );
}

// Continues a resumed artifact approval from the persisted artifacts, never from a fresh
// planning turn: an approved spec.md drives plan/brief regeneration and then the plan gate,
// and a plan the planner revised at either gate invalidates the briefs it produced, so they
// are regenerated before the briefs gate reads tasks.md. This is what rewind.ts does after
// its own APPROVE_SPEC; re-planning would overwrite the artifact just approved and re-prompt
// the same gate.
async function continueApprovedArtifact(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  phase: 'reviewing-spec' | 'reviewing-plan';
  approval: { state: WorkflowState; regenerated: boolean };
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, setTrackedState } = opts;
  const { projectDir, sessionId, callbacks, bus, metadata, sinks, signal, planner } = wctx;
  const ref = { projectDir, sessionId };
  let { state, regenerated } = opts.approval;
  let tasks = state.tasks;

  if (opts.phase === 'reviewing-spec') {
    state = transitionAndSave(ref, state, { type: 'APPROVE_SPEC' });
    const planAndTasks = await regeneratePlanAndTasks({
      ...ref,
      planner,
      callbacks,
      bus,
      state,
      metadata,
      signal,
      sinks,
    });
    tasks = planAndTasks.tasks;
    state = transitionAndSave(ref, planAndTasks.state, { type: 'PLAN_DONE', tasks });
    setTrackedState(state);

    const planApproval = await resumeArtifactApproval({ wctx, state, phase: 'reviewing-plan' });
    if (planApproval.cancelled) return { state: planApproval.state, cancelled: true };
    state = planApproval.state;
    regenerated = planApproval.regenerated;
  }

  const regen = await regenerateTasksIfNeeded({
    ...ref,
    regenerated,
    planner,
    callbacks,
    bus,
    state,
    tasks,
    metadata,
    signal,
    sinks,
  });
  state = transitionAndSave(ref, regen.state, { type: 'BRIEFS_READY', tasks: regen.tasks });
  const briefs = await resumeBriefsApproval({ wctx, state });
  return { state: briefs.state, cancelled: briefs.cancelled };
}

export async function runPlanningPhases(
  opts: RunPlanningPhasesOptions,
): Promise<{ state: WorkflowState; cancelled: boolean; failed: boolean }> {
  const {
    wctx,
    savedState,
    selectedSkills,
    phaseTimings,
    startTime,
    setTrackedState,
    rewindFeedback,
  } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  const interrupted = isInterruptedPlanningTurn(state);
  const shouldRunPlanning = !savedState || Boolean(savedState.rewindPending) || interrupted;
  const rewindPending =
    savedState?.rewindPending === undefined
      ? undefined
      : {
          ...savedState.rewindPending,
          ...(rewindFeedback !== undefined && { comment: rewindFeedback }),
        };

  if (interrupted) {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'CONTINUE_TURN' });
    setTrackedState(state);
  }

  const parkedArtifact = APPROVAL_PARKED_ARTIFACT[state.phase];
  if (parkedArtifact !== undefined) {
    const resumeWctx: PlannerCallbacksContext & { planner: Planner } = {
      projectDir,
      sessionId,
      config,
      callbacks,
      bus: wctx.bus,
      signal: wctx.signal,
      metadata: wctx.metadata,
      sinks: wctx.sinks,
      drainPendingAttachments: wctx.drainPendingAttachments,
      ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
      ...(wctx.detectedContextLength !== undefined && {
        detectedContextLength: wctx.detectedContextLength,
      }),
      planner,
    };

    if (state.phase === 'reviewing-briefs') {
      const resumed = await resumeBriefsApproval({ wctx: resumeWctx, state });
      state = resumed.state;
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return { state, cancelled: resumed.cancelled, failed: false };
    }

    const resumePhase = state.phase;
    if (resumePhase === 'reviewing-spec' || resumePhase === 'reviewing-plan') {
      const resumed = await resumeArtifactApproval({ wctx: resumeWctx, state, phase: resumePhase });
      const continued = resumed.cancelled
        ? { state: resumed.state, cancelled: true }
        : await continueApprovedArtifact({
            wctx: resumeWctx,
            phase: resumePhase,
            approval: resumed,
            setTrackedState,
          });
      state = continued.state;
      setTrackedState(state);
      phaseTimings.planning = Date.now() - startTime;
      return { state, cancelled: continued.cancelled, failed: false };
    }
  }

  if (shouldRunPlanning) {
    if (config.hooks) {
      const prePlanPayload: EngineEvent = {
        type: 'workflow_started',
        ts: Date.now(),
        phase: state.phase,
        feature: state.feature,
      };
      const pre = await runPreHooks(config.hooks, 'pre_planning', prePlanPayload, {
        projectDir,
        sessionId,
      });
      if (!pre.allow) {
        publishWarning({
          bus: wctx.bus,
          phase: state.phase,
          message: `pre_planning blocked: ${pre.reason ?? 'hook denied'}`,
        });
        return { state, cancelled: true, failed: false };
      }
    }

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
        ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
        ...(wctx.detectedContextLength !== undefined && {
          detectedContextLength: wctx.detectedContextLength,
        }),
      },
      planner,
      state,
      feature: plannerFeature,
      selectedSkills,
      ...(rewindPending !== undefined && { rewindPending }),
    });
    state = planning.state;
    setTrackedState(state);
    phaseTimings.planning = Date.now() - startTime;
    if (planning.cancelled) return { state, cancelled: true, failed: planning.failed ?? false };
  }

  return { state, cancelled: false, failed: false };
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
      ...(opts.wctx.detectedContextLength !== undefined && {
        detectedContextLength: opts.wctx.detectedContextLength,
      }),
    }),
    ...(opts.plannerEstimateReview !== undefined && {
      plannerEstimateReview: opts.plannerEstimateReview,
    }),
  };
}

const APPROVAL_PARKED_ARTIFACT: Partial<Record<Phase, string>> = {
  'reviewing-spec': SPEC_FILE,
  'reviewing-plan': PLAN_FILE,
  'reviewing-briefs': TASKS_FILE,
};

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; cancelled: boolean; state: WorkflowState }> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;

  const parkedArtifact = APPROVAL_PARKED_ARTIFACT[state.phase];
  if (parkedArtifact !== undefined) {
    const artifactPath = join(sessionDir(wctx.projectDir, wctx.sessionId), parkedArtifact);
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      safety: {
        category: 'approval',
        code: 'approval_prompt_not_restored',
        transcriptSafe: true,
      },
      message: `Refusing to continue from ${state.phase} without a restored approval prompt. Review artifact: ${artifactPath}`,
    });
    return {
      summary: buildSummary({ ...summaryBase, state, phaseTimings }),
      completed: false,
      cancelled: false,
      state,
    };
  }

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
          return {
            summary: buildSummary({ ...summaryBase, state, phaseTimings }),
            completed: false,
            cancelled: false,
            state,
          };
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
            cancelled: false,
            state,
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
    cancelled: false,
    state: finalReview.state,
  };
}
