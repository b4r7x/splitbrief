import type { Config, WorkflowState, Summary, OrchestratorCallbacks, SkillMeta, ProjectContext, Task, Session } from '../../types.js';
import { DEFAULT_WORKFLOW_MODE } from '../../types.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/runner-config.js';
import { createInitialState, CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { saveState, appendMessage } from '../../core/state/persistence.js';
import { saveSummary } from '../../core/sessions/io.js';
import { generateSessionId } from '../../core/sessions/id.js';
import { clearActive } from '../../core/sessions/active.js';
import { ensureSessionDir, ensureDiptychDir, type SpecMetadata } from '../../core/paths-io.js';
import { readPackageJson } from '../../utils/fs.js';
import { resolveAutoModel } from '../../core/providers.js';
import { killAllProcesses } from '../../utils/process-lifecycle.js';
import { toErrorMessage, labelError } from '../../utils/format.js';
import { warnError } from '../../utils/warn.js';
import { createPlanner, createImplementer } from '../runners/factory.js';

import type { WorkflowContext } from './types.js';
import { buildSummary, type SummaryBase } from './summary.js';
import { emit, emitError, emitWarning, emitPlannerStatus, emitCostPrediction, emitWorkflowConfig } from './events.js';
import { predictCost } from './cost-prediction.js';
import { transitionAndSave, withSignalHandlers } from './helpers.js';
import { runPlanningPhase } from './planning.js';
import { runTaskLoop } from './task-loop.js';
import { runFinalReviewPhase, shutdownWorkflow } from './final-review.js';

export type { WorkflowContext } from './types.js';

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
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
): Promise<InitResult> {
  const { feature, projectDir, config, callbacks, savedState } = opts;

  ensureDiptychDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  const planner = createPlanner(config);
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

  const wctx: WorkflowContext = { projectDir, sessionId, config, callbacks, planner, context, implementer, signal: opts.signal, metadata };

  return { ok: true, state, wctx };
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

  if (!savedState) {
    const planning = await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, signal: wctx.signal, metadata: wctx.metadata },
      planner,
      state,
      feature: state.feature,
      selectedSkills,
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

  const saveFinalSession = (summary: Summary) => {
    try {
      const session: Session = {
        id: sessionId,
        feature,
        startedAt: startTime,
        completedAt: Date.now(),
        stateVersion: CURRENT_STATE_VERSION,
        stateFile: null,
        status: sessionStatus,
        summary,
      };
      saveSummary(projectDir, sessionId, session);
      clearActive(projectDir);
    } catch (err) {
      warnError('Failed to save final session', err);
    }
  };

  const shutdown = () => shutdownWorkflow(projectDir, sessionId, () => trackedState, () => currentTask);

  const { cancelled } = await withSignalHandlers(shutdown, async () => {
    try {
      const init = await initializeWorkflow(opts, sessionId, summaryBase, metadata, (s) => { trackedState = s; });
      if (!init.ok) { result = init.summary; return; }

      const { wctx } = init;
      trackedState = init.state;
      const phaseTimings: Record<string, number> = {};

      const planning = await runPlanningPhases({
        wctx, state: init.state, savedState, selectedSkills, phaseTimings, startTime,
        setTrackedState: (s) => { trackedState = s; },
      });
      if (planning.cancelled) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

      if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

      result = await runTasksAndReview({
        wctx, state: planning.state, summaryBase, phaseTimings,
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
  });

  if (!result) {
    if (cancelled) {
      const summary = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
      saveFinalSession(summary);
      return summary;
    }
    throw new Error('Unreachable: workflow did not produce a summary');
  }
  saveFinalSession(result);
  return result;
}
