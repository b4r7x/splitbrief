import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowContext } from '../types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { EventBus } from '../../events/types.js';

import { buildSummary, type SummaryBase } from '../summary.js';
import { publishCostPrediction, publishError, publishWarning } from '../events.js';
import { decideCostGate } from '../cost-gate.js';
import { predictCost } from '../budget/cost-prediction.js';
import { estimateDeterministicCost } from '../budget/estimate.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { reviewPlannerEstimate, runningPlannerEstimateReview } from '../planner-estimate-review.js';
import { autoSplitOverflowTasks, type AutoSplitOverflowSkippedSplit } from '../auto-split-overflow.js';
import { runPlanningPhase } from '../planning/run.js';
import { runBriefQualityGate } from '../planning/shared.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { drainQueue } from '../queue.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasks } from '../../spec/parser.js';
import { transitionAndSave } from '../state-ops.js';

export function applyPostPlanDrain(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
  setTrackedState: (s: WorkflowState) => void,
): WorkflowState {
  const drain = drainQueue(projectDir, sessionId, state, bus);
  if (drain.messages.length === 0) return state;
  setTrackedState(drain.state);
  return drain.state;
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

export async function runPlanningPhases(opts: RunPlanningPhasesOptions): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, savedState, selectedSkills, phaseTimings, startTime, setTrackedState } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  if (!savedState || savedState.rewindPending) {
    const planning = await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, bus: wctx.bus, signal: wctx.signal, metadata: wctx.metadata, sinks: wctx.sinks, drainPendingAttachments: wctx.drainPendingAttachments },
      planner,
      state,
      feature: state.feature,
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
    }),
    deterministic: estimateDeterministicCost({
      tasks: opts.tasks,
      context: opts.wctx.context,
      config: opts.wctx.config,
      pricingCache: opts.wctx.modelCache,
      languageContext: buildProjectLanguageContext(opts.wctx.projectDir, opts.state.discoveredValidation?.language),
    }),
    ...(opts.plannerEstimateReview !== undefined && { plannerEstimateReview: opts.plannerEstimateReview }),
  };
}

async function readApprovedSplitTasks(tasksFilePath: string): Promise<Task[] | null> {
  try {
    const text = await readFile(tasksFilePath, 'utf8');
    const tasks = parseTasks(text);
    return tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

async function reviewAutoSplitOutput(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  tasks: Task[];
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; tasks: Task[]; approved: boolean }> {
  const tasksFilePath = join(sessionDir(opts.wctx.projectDir, opts.wctx.sessionId), TASKS_FILE);
  writeSpecFile(opts.wctx.projectDir, opts.wctx.sessionId, TASKS_FILE, formatTasks(opts.tasks), opts.wctx.metadata);
  publishWarning(opts.wctx.bus, opts.state.phase, `Auto-split overflow produced ${opts.tasks.length} Task Briefs. Review ${TASKS_FILE} before implementation.`);

  let state = transitionAndSave(opts.wctx.projectDir, opts.wctx.sessionId, opts.state, { type: 'BRIEFS_READY', tasks: opts.tasks });
  opts.setTrackedState(state);

  const result = await opts.wctx.callbacks.onApprovalNeeded('briefs', tasksFilePath);
  if (!result.approved && result.action !== 'edit') {
    publishError(opts.wctx.bus, state.phase, result.comment ? `Auto-split overflow rejected: ${result.comment}` : 'Auto-split overflow rejected before implementation.');
    state = transitionAndSave(opts.wctx.projectDir, opts.wctx.sessionId, state, { type: 'REJECT_BRIEFS' });
    opts.setTrackedState(state);
    return { state, tasks: opts.tasks, approved: false };
  }

  const approvedTasks = await readApprovedSplitTasks(tasksFilePath);
  if (!approvedTasks) {
    publishError(opts.wctx.bus, state.phase, `Auto-split overflow review failed: ${tasksFilePath} has no parseable Task Briefs.`);
    return { state, tasks: opts.tasks, approved: false };
  }

  const { ok, report } = runBriefQualityGate(approvedTasks, opts.wctx.projectDir, opts.wctx.sessionId, opts.wctx.bus, state.phase);
  if (!ok) {
    const firstError = report.issues.find(issue => issue.severity === 'error');
    publishError(opts.wctx.bus, state.phase, `Auto-split overflow review failed quality gate: ${firstError?.message ?? 'unknown error'}`);
    return { state, tasks: approvedTasks, approved: false };
  }

  state = transitionAndSave(opts.wctx.projectDir, opts.wctx.sessionId, state, { type: 'BRIEFS_READY', tasks: approvedTasks });
  state = transitionAndSave(opts.wctx.projectDir, opts.wctx.sessionId, state, { type: 'APPROVE_BRIEFS' });
  opts.setTrackedState(state);
  return { state, tasks: approvedTasks, approved: true };
}

function formatSkippedSplitNotice(skippedSplits: AutoSplitOverflowSkippedSplit[]): string {
  return skippedSplits
    .map(skipped => {
      const reason = skipped.reason.trim();
      const punctuatedReason = /[.!?]$/.test(reason) ? reason : `${reason}.`;
      return `Auto-split overflow skipped ${skipped.taskId}: ${punctuatedReason} Original task will continue unless routing/recovery requires a different action.`;
    })
    .join('; ');
}

export async function runTasksAndReview(opts: RunTasksAndReviewOptions): Promise<{ summary: Summary; completed: boolean }> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;

  if (state.tasks.length > 0) {
    let prediction: CostPrediction = predictTasksCost({ tasks: state.tasks, summaryBase, wctx, state });
    if (wctx.config.plannerEstimateReview) {
      prediction.plannerEstimateReview = runningPlannerEstimateReview();
    }
    publishCostPrediction(wctx.bus, state.phase, prediction);

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
      });
      state = reviewed.state;
      setTrackedState(state);
      prediction = { ...prediction, plannerEstimateReview: reviewed.review };
      publishCostPrediction(wctx.bus, state.phase, prediction);
    }

    if (prediction.deterministic) {
      const split = autoSplitOverflowTasks({
        enabled: wctx.config.autoSplitOverflow,
        tasks: state.tasks,
        estimate: prediction.deterministic,
        plannerReview: prediction.plannerEstimateReview,
      });
      if (split.skippedSplits.length > 0) {
        publishWarning(wctx.bus, state.phase, formatSkippedSplitNotice(split.skippedSplits));
      }
      if (split.changed) {
        const reviewed = await reviewAutoSplitOutput({ wctx, state, tasks: split.tasks, setTrackedState });
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
        publishCostPrediction(wctx.bus, state.phase, prediction);
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
      summary: buildSummary({ ...summaryBase, state, taskBreakdowns: taskResult.taskBreakdowns, phaseTimings }),
      completed: false,
    };
  }

  if (taskResult.status !== 'complete') {
    return {
      summary: buildSummary({ ...summaryBase, state, taskBreakdowns: taskResult.taskBreakdowns, phaseTimings }),
      completed: false,
    };
  }

  const summary = await runFinalReviewPhase(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, config: wctx.config, callbacks, bus: wctx.bus, state, planner: wctx.planner, metadata: wctx.metadata },
    summaryBase,
    taskResult.taskBreakdowns,
    phaseTimings,
  );
  return { summary, completed: true };
}
