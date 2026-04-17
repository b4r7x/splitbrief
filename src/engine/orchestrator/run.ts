import type { Config } from '../../core/types/config-options.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/types/config-options.js';
import type { WorkflowState, Task, ProjectContext } from '../../core/types/state-actions.js';
import type { Summary } from '../../core/types/summary.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { SkillMeta, Session } from '../../core/types/app.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/runner-config.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState, appendMessage } from '../../core/state/persistence.js';
import { generateSessionId } from '../../core/sessions/id.js';
import { ensureSessionDir, ensureDiptychDir, type SpecMetadata } from '../../core/paths-io.js';
import { readPackageJson } from '../../core/project-meta.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { toErrorMessage, labelError } from '../../utils/format-errors.js';
import { createPlanner, createImplementer } from '../runners/factory.js';

import type { WorkflowContext, WorkflowSinks, ResumeContextHolder } from './types.js';
import { buildSummary, type SummaryBase } from './summary.js';
import { emit, emitError, emitWarning, emitPlannerStatus, emitCostPrediction, emitWorkflowConfig, emitUserMessage } from './events.js';
import { predictCost } from './cost-prediction.js';
import { transitionAndSave, applyRebuiltContext } from './helpers.js';
import { runPlanningPhase } from './planning/run.js';
import { runTaskLoop } from './task-loop.js';
import { runFinalReviewPhase } from './final-review.js';
import { drainQueue } from './queue-drain.js';
import { saveFinalSession, withShutdownHandlers, installQueueHandler } from './session-lifecycle.js';

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
};

type InitResult =
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
  | { ok: false; summary: Summary };

async function initializeWorkflow(
  opts: RunWorkflowOptions,
  sessionId: string,
  summaryBase: SummaryBase,
  metadata: SpecMetadata,
  setTrackedState: (s: WorkflowState) => void,
  resumeHolder: ResumeContextHolder,
): Promise<InitResult> {
  const { feature, projectDir, config, callbacks, savedState, sinks } = opts;

  ensureDiptychDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const planner = createPlanner(config, initialSessionId);
  if (savedState && !planner.capabilities.supportsSessionResume) {
    await applyRebuiltContext({ projectDir, sessionId, callbacks, config, resumeHolder, requireNonEmpty: true });
  }
  const available = await planner.isAvailable();
  if (!available) {
    emitError(callbacks, `Planner '${getRunnerDisplayName(config.planner)}' is not available. Make sure it's installed.`);
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  const implementer = createImplementer(config);

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, sessionId, state, 'workflow_resumed', undefined, {});
  } else {
    state = createInitialState(feature);
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && { implementerModel: summaryBase.implementerModel }),
    };
    state = transitionAndSave(projectDir, sessionId, state, { type: 'START', feature });
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, sessionId, state, 'workflow_started', undefined, {});
    appendMessage(projectDir, sessionId, { role: 'user', text: feature }, config.workflow.persistTranscript);
    emitUserMessage(callbacks, feature);
  }

  emitWorkflowConfig(callbacks, {
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
  });

  const pkg = readPackageJson(projectDir);
  const context: ProjectContext = {
    name: typeof pkg?.['name'] === 'string' ? pkg['name'] : 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand,
  };

  const wctx: WorkflowContext = { projectDir, sessionId, config, callbacks, planner, context, implementer, signal: opts.signal, metadata, resumeHolder, sinks };

  return { ok: true, state, wctx };
}

function applyPostPlanDrain(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  callbacks: OrchestratorCallbacks,
  setTrackedState: (s: WorkflowState) => void,
): WorkflowState {
  const drain = drainQueue(projectDir, sessionId, state, callbacks);
  if (drain.messages.length === 0) return state;
  setTrackedState(drain.state);
  return drain.state;
}

type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
};

async function runPlanningPhases(opts: RunPlanningPhasesOptions): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, savedState, selectedSkills, phaseTimings, startTime, setTrackedState } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  if (!savedState || savedState.rewindPending) {
    const planning = await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, signal: wctx.signal, metadata: wctx.metadata, sinks: wctx.sinks },
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

type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

async function runTasksAndReview(opts: RunTasksAndReviewOptions): Promise<Summary> {
  const { wctx, summaryBase, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { state } = opts;
  const { callbacks } = wctx;

  if (state.tasks.length > 0) {
    const prediction = predictCost({
      taskCount: state.tasks.length,
      plannerTool: state.plannerTool ?? '',
      implementerTool: state.implementerTool ?? '',
      tokenUsage: state.tokenUsage,
    });
    emitCostPrediction(callbacks, prediction);
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
    return buildSummary({ ...summaryBase, state, taskBreakdowns: taskResult.taskBreakdowns, phaseTimings });
  }

  return runFinalReviewPhase(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, callbacks, state, planner: wctx.planner, metadata: wctx.metadata },
    summaryBase,
    taskResult.taskBreakdowns,
    phaseTimings,
  );
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = resolveAutoModel(config.implementer.model, getRunnerDisplayName(config.implementer));
  const summaryBase: SummaryBase = {
    feature, startTime,
    plannerTool: getRunnerDisplayName(config.planner),
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(implementerModel !== undefined && { implementerModel }),
  };

  const metadata: SpecMetadata = {
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  };

  const sessionId = opts.sessionId ?? generateSessionId(projectDir, feature);

  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';

  const { cancelled } = await withShutdownHandlers(
    {
      projectDir, sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => currentTask,
    },
    async () => {
      try {
        const resumeHolder: ResumeContextHolder = { messages: [] };
        const init = await initializeWorkflow(opts, sessionId, summaryBase, metadata, (s) => { trackedState = s; }, resumeHolder);
        if (!init.ok) { result = init.summary; return; }

        const { wctx } = init;
        trackedState = init.state;
        const phaseTimings: Record<string, number> = {};

        installQueueHandler({
          projectDir, sessionId,
          sinks: wctx.sinks,
          getTrackedState: () => trackedState,
          setTrackedState: (s) => { trackedState = s; },
          callbacks,
          config,
          planner: wctx.planner,
        });

        const planning = await runPlanningPhases({
          wctx, state: init.state, savedState, selectedSkills, phaseTimings, startTime,
          setTrackedState: (s) => { trackedState = s; },
        });
        if (planning.cancelled) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        const postPlanState = applyPostPlanDrain(projectDir, sessionId, planning.state, callbacks, (s) => { trackedState = s; });

        result = await runTasksAndReview({
          wctx, state: postPlanState, summaryBase, phaseTimings,
          setTrackedState: (s) => { trackedState = s; },
          setCurrentTask: (t) => { currentTask = t; },
        });
        sessionStatus = 'complete';
      } catch (err) {
        if (trackedState) {
          try { saveState(projectDir, sessionId, trackedState); } catch (saveErr) {
            emitWarning(callbacks, labelError('Failed to save state', saveErr));
          }
        }
        killAllProcesses();
        emitError(callbacks, toErrorMessage(err));
        sessionStatus = 'failed';
        result = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
      }
    },
  );

  if (!result) {
    if (cancelled) {
      const summary = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
      saveFinalSession({ projectDir, sessionId, feature, startTime, status: sessionStatus, summary });
      return summary;
    }
    throw new Error('Unreachable: workflow did not produce a summary');
  }
  saveFinalSession({ projectDir, sessionId, feature, startTime, status: sessionStatus, summary: result });
  return result;
}
