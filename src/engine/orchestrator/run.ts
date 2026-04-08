import type { Config, WorkflowState, TaskTokenUsage, Summary, OrchestratorCallbacks, SkillMeta, ProjectContext, PlannerTokenUsage, Task } from '../../types.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { ensureTinySpecDir, writeSpecFile, readPackageJson, readSpecFile } from '../../utils/fs.js';
import { killAllProcesses } from '../../utils/process.js';
import { discardTaskChanges, getCurrentDiff } from '../../utils/git.js';
import { toErrorMessage } from '../../utils/format.js';
import { createPlanner } from '../planners/factory.js';
import { createImplementer } from '../implementers/factory.js';
import { buildFinalReviewPrompt } from '../spec/prompts/review.js';

import type { Planner } from '../planners/types.js';
import type { Implementer } from '../implementers/types.js';
import { buildSummary } from './cost.js';
import { createTextHandler, emit } from './events.js';
import { addUsageAndSave, transitionAndSave, withSignalHandlers, isSignalError } from './helpers.js';
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

type SummaryBase = { feature: string; startTime: number; plannerTool: string; implementerTool: string };

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
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: 'Shell implementer requires implementer.command to be set in config.' });
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  ensureTinySpecDir(projectDir);

  const planner = await createPlanner(config);
  const available = await planner.isAvailable();
  if (!available) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Planner '${config.planner.tool}' is not available. Make sure it's installed.` });
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  const implementer = await createImplementer(config);

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
    emit(projectDir, state, 'workflow_resumed');
  } else {
    state = createInitialState(feature);
    state = transitionAndSave(projectDir, state, { type: 'START', feature });
    setTrackedState(state);
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
    emit(projectDir, state, 'workflow_started');
  }

  const pkg = readPackageJson(projectDir);
  const context: ProjectContext = {
    name: (pkg?.name as string) ?? 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand,
  };

  const wctx: WorkflowContext = { projectDir, config, callbacks, planner, context, implementer, signal: opts.signal };

  return { ok: true, state, wctx };
}

async function runFinalReview(
  projectDir: string,
  callbacks: OrchestratorCallbacks,
  planner: Planner,
): Promise<{ text: string; usage: PlannerTokenUsage | null }> {
  const diff = await getCurrentDiff(projectDir);
  const spec = readSpecFile(projectDir, 'spec.md') ?? '';
  const prompt = buildFinalReviewPrompt(spec, diff);
  const emitText = createTextHandler(callbacks);
  return planner.review(prompt, projectDir, { onOutput: emitText });
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
  callbacks.onEvent({ type: 'planner-status', ts: finalReviewStart, phase: state.phase, status: 'running' });
  emit(projectDir, state, 'all_tasks_done');

  try {
    const reviewResult = await runFinalReview(projectDir, callbacks, planner);
    writeSpecFile(projectDir, 'review.md', reviewResult.text);
    state = addUsageAndSave(projectDir, state, 'planner', reviewResult.usage, callbacks);
  } catch (err) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Final review failed: ${toErrorMessage(err)}` });
  }

  state = transitionAndSave(projectDir, state, { type: 'REVIEW_DONE' });
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done', duration: Date.now() - finalReviewStart });
  emit(projectDir, state, 'workflow_complete');

  const summary = buildSummary({ ...summaryBase, state, taskBreakdowns });
  callbacks.onComplete(summary);
  return summary;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const summaryBase: SummaryBase = { feature, startTime, plannerTool: config.planner.tool, implementerTool: config.implementer.tool };
  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;

  const shutdown = () => {
    killAllProcesses();
    if (trackedState) {
      try { saveState(projectDir, trackedState); } catch (err) {
        process.stderr.write(`Warning: failed to save state during shutdown: ${err}\n`);
      }
    }
    if (currentTask) {
      try { discardTaskChanges(projectDir, currentTask.file, currentTask.action); } catch (err) {
        process.stderr.write(`Warning: failed to discard changes during shutdown: ${err}\n`);
      }
    }
  };

  await withSignalHandlers(shutdown, async () => {
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
          callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Failed to save state: ${saveErr}` });
        }
      }
      killAllProcesses();
      if (!isSignalError(err)) {
        const msg = toErrorMessage(err);
        callbacks.onEvent({ type: 'error', ts: Date.now(), message: msg });
      }
      result = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
    }
  });

  if (!result) throw new Error('Unreachable: workflow did not produce a summary');
  return result;
}
