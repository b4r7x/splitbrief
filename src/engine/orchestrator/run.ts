import type { Config, WorkflowState, Summary, OrchestratorCallbacks, SkillMeta, ProjectContext, Task, Session } from '../../types.js';
import { randomUUID } from 'node:crypto';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/runner-config.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { saveSession, getSessionDir } from '../../core/sessions/io.js';
import { ensureTinySpecDir, setSpecMetadata, resetSpecMetadata } from '../../core/paths-io.js';
import { readPackageJson } from '../../utils/fs.js';
import { resolveAutoModel } from '../../core/providers.js';
import { killAllProcesses } from '../../utils/process.js';
import { toErrorMessage, warnError } from '../../utils/format.js';
import { createPlanner } from '../runners/factory.js';
import { createImplementer } from '../runners/factory.js';

import type { Planner } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import { buildSummary, type SummaryBase } from './cost.js';
import { emit, emitError, emitWarning, emitPlannerStatus, emitCostPrediction, emitWorkflowConfig } from './events.js';
import { predictCost } from './cost-prediction.js';
import { transitionAndSave, withSignalHandlers } from './helpers.js';
import { runPlanningPhase } from './planning.js';
import { runTaskLoop } from './task-loop.js';
import { runFinalReviewPhase, shutdownWorkflow } from './final-review.js';

export interface WorkflowContext {
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  signal?: AbortSignal | undefined;
}

export type PlannerCallbacksContext = Pick<WorkflowContext, 'projectDir' | 'config' | 'callbacks'>;

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  savedState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
};

type InitResult =
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
  | { ok: false; summary: Summary };

async function initializeWorkflow(
  opts: RunWorkflowOptions,
  summaryBase: SummaryBase,
  setTrackedState: (s: WorkflowState) => void,
): Promise<InitResult> {
  const { feature, projectDir, config, callbacks, savedState } = opts;

  ensureTinySpecDir(projectDir);

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
    emit(projectDir, state, 'workflow_resumed', undefined, {});
  } else {
    state = createInitialState(feature);
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && { implementerModel: summaryBase.implementerModel }),
    };
    state = transitionAndSave(projectDir, state, { type: 'START', feature });
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, state, 'workflow_started', undefined, {});
  }

  emitWorkflowConfig(callbacks, {
    mode: config.workflow.mode ?? 'standard',
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

  const wctx: WorkflowContext = { projectDir, config, callbacks, planner, context, implementer, signal: opts.signal };

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
  const { projectDir, config, callbacks, planner } = wctx;

  if (!savedState) {
    const planning = await runPlanningPhase({
      wctx: { projectDir, config, callbacks },
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
    { projectDir: wctx.projectDir, callbacks, state, planner: wctx.planner },
    summaryBase,
    taskResult.taskBreakdowns,
    phaseTimings,
  );
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = resolveAutoModel(config.implementer.model);
  const summaryBase: SummaryBase = {
    feature, startTime,
    plannerTool: getRunnerDisplayName(config.planner),
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(implementerModel !== undefined && { implementerModel }),
  };

  setSpecMetadata({
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
    mode: config.workflow.mode ?? 'standard',
  });
  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';

  const saveFinalSession = (summary: Summary) => {
    try {
      const base = {
        id: randomUUID(),
        feature,
        startedAt: startTime,
        completedAt: Date.now(),
        stateVersion: 1,
        stateFile: null,
      };
      const session: Session = { ...base, status: sessionStatus, summary };
      saveSession(getSessionDir('project', projectDir), session);
    } catch (err) {
      warnError('Failed to save final session', err);
    }
  };

  const shutdown = () => shutdownWorkflow(projectDir, () => trackedState, () => currentTask);

  try {
    const { cancelled } = await withSignalHandlers(shutdown, async () => {
      try {
        const init = await initializeWorkflow(opts, summaryBase, (s) => { trackedState = s; });
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
          try { saveState(projectDir, trackedState); } catch (saveErr) {
            emitWarning(callbacks, `Failed to save state: ${toErrorMessage(saveErr)}`);
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
  } finally {
    resetSpecMetadata();
  }
}
