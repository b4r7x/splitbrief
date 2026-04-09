import type { Config, WorkflowState, TaskTokenUsage, Summary, OrchestratorCallbacks, SkillMeta, ProjectContext, Task } from '../../types.js';
import { getPlannerToolName } from '../../core/config/planner-config.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { ensureTinySpecDir, readSpecFileOrEmpty } from '../../core/paths-io.js';
import { readPackageJson } from '../../utils/fs.js';
import { SPEC_FILE, REVIEW_FILE } from '../../core/paths.js';
import { killAllProcesses } from '../../utils/process.js';
import { getCurrentDiff } from '../../utils/git.js';
import { discardTaskChanges } from './git-ops.js';
import { toErrorMessage, warnError } from '../../utils/format.js';
import { createPlanner } from '../planners/factory.js';
import { createImplementer } from '../implementers/factory.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';

import type { Planner } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import { buildSummary, type SummaryBase } from './cost.js';
import { emit, emitError, emitWarning, emitPlannerStatus } from './events.js';
import { transitionAndSave, withSignalHandlers, runPlannerReview } from './helpers.js';
import { runPlanningPhase } from './planning.js';
import { runTaskLoop } from './task-loop.js';

export interface WorkflowContext {
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  planner: Planner;
  context: ProjectContext;
  implementer: Implementer;
  signal?: AbortSignal | undefined;
}

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

  if (config.implementer.kind === 'shell' && !config.implementer.command) {
    emitError(callbacks, 'Shell implementer requires implementer.command to be set in config.');
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  ensureTinySpecDir(projectDir);

  const planner = await createPlanner(config);
  const available = await planner.isAvailable();
  if (!available) {
    emitError(callbacks, `Planner '${getPlannerToolName(config.planner)}' is not available. Make sure it's installed.`);
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  const implementer = await createImplementer(config);

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, state, 'workflow_resumed', undefined, {});
  } else {
    state = createInitialState(feature);
    state = transitionAndSave(projectDir, state, { type: 'START', feature });
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, state, 'workflow_started', undefined, {});
  }

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

async function runFinalReviewPhase(
  opts: { projectDir: string; callbacks: OrchestratorCallbacks; state: WorkflowState; planner: Planner },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
): Promise<Summary> {
  let { state } = opts;
  const { projectDir, callbacks, planner } = opts;

  state = transitionAndSave(projectDir, state, { type: 'ALL_DONE' });
  const finalReviewStart = Date.now();
  emitPlannerStatus(callbacks, state, 'running');
  emit(projectDir, state, 'all_tasks_done', undefined, {});

  try {
    const diff = await getCurrentDiff(projectDir);
    const spec = readSpecFileOrEmpty(projectDir, SPEC_FILE);
    const review = await runPlannerReview({
      planner,
      prompt: buildFinalReviewPrompt(spec, diff),
      projectDir,
      callbacks,
      state,
      writeTo: REVIEW_FILE,
    });
    state = review.state;
  } catch (err) {
    emitError(callbacks, `Final review failed: ${toErrorMessage(err)}`);
  }

  state = transitionAndSave(projectDir, state, { type: 'REVIEW_DONE' });
  emitPlannerStatus(callbacks, state, 'done', { duration: Date.now() - finalReviewStart });
  emit(projectDir, state, 'workflow_complete', undefined, {});

  const summary = buildSummary({ ...summaryBase, state, taskBreakdowns });
  callbacks.onComplete(summary);
  return summary;
}

function shutdownWorkflow(
  projectDir: string,
  getTrackedState: () => WorkflowState | undefined,
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined,
): void {
  killAllProcesses();
  const trackedState = getTrackedState();
  if (trackedState) {
    try { saveState(projectDir, trackedState); } catch (err) {
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

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const summaryBase: SummaryBase = { feature, startTime, plannerTool: getPlannerToolName(config.planner), implementerTool: config.implementer.tool };
  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;

  const shutdown = () => shutdownWorkflow(projectDir, () => trackedState, () => currentTask);

  const { cancelled } = await withSignalHandlers(shutdown, async () => {
    try {
      const init = await initializeWorkflow(opts, summaryBase, (s) => { trackedState = s; });
      if (!init.ok) { result = init.summary; return; }

      let { state } = init;
      const { wctx } = init;
      trackedState = state;

      if (!savedState) {
        const planning = await runPlanningPhase({ feature, projectDir, config, callbacks, planner: wctx.planner, state, selectedSkills });
        state = planning.state;
        trackedState = state;
        if (planning.cancelled) { result = buildSummary({ ...summaryBase, state }); return; }
      }

      if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state }); return; }

      const taskResult = await runTaskLoop({
        wctx, initialState: state,
        setTrackedState: (s) => { trackedState = s; },
        setCurrentTask: (t) => { currentTask = t; },
      });

      if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state: taskResult.state, taskBreakdowns: taskResult.taskBreakdowns }); return; }

      result = await runFinalReviewPhase(
        { projectDir, callbacks, state: taskResult.state, planner: wctx.planner },
        summaryBase, taskResult.taskBreakdowns,
      );
    } catch (err) {
      if (trackedState) {
        try { saveState(projectDir, trackedState); } catch (saveErr) {
          emitWarning(callbacks, `Failed to save state: ${toErrorMessage(saveErr)}`);
        }
      }
      killAllProcesses();
      emitError(callbacks, toErrorMessage(err));
      result = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
    }
  });

  if (!result) {
    if (cancelled) {
      return buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
    }
    throw new Error('Unreachable: workflow did not produce a summary');
  }
  return result;
}
