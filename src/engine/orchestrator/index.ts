import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Config, WorkflowState, TaskTokenUsage, Summary, OrchestratorCallbacks, SkillMeta, ProjectContext } from '../../types.js';
import { createInitialState, transition } from '../../core/state.js';
import { saveState } from '../../core/state-persistence.js';
import { ensureTinySpecDir, writeSpecFile } from '../../utils/fs.js';
import { killAllProcesses } from '../../utils/process.js';
import { discardTaskChanges } from '../../utils/git.js';
import { toErrorMessage } from '../../utils/format.js';
import { createPlanner } from '../planners/factory.js';
import { createImplementer } from '../implementers/factory.js';

import type { WorkflowContext } from './types.js';
import { buildSummary } from './cost.js';
import { emit } from './events.js';
import { addUsageAndSave, withSignalHandlers } from './helpers.js';
import { runFinalReview } from './final-review.js';
import { runPlanningPhase } from './planning.js';
import { runTaskLoop } from './task-loop.js';

export type { WorkflowContext } from './types.js';
export { estimateCostSavings, calculateCostBreakdown } from './cost.js';
export { allValidationsPassed } from './helpers.js';
export { hasDependencyFailed } from './task-loop.js';

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  savedState?: WorkflowState;
  selectedSkills?: SkillMeta[];
};

type SummaryBase = { feature: string; startTime: number; plannerTool: string; implementerProvider: string };

type InitResult =
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
  | { ok: false; summary: Summary };

function readProjectName(projectDir: string): string {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.name ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function initializeWorkflow(
  opts: RunWorkflowOptions,
  summaryBase: SummaryBase,
  setTrackedState: (s: WorkflowState) => void,
): Promise<InitResult> {
  const { feature, projectDir, config, callbacks, savedState } = opts;

  if (config.implementer.type === 'shell' && !config.implementer.command) {
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
    state = transition(state, { type: 'START', feature });
    saveState(projectDir, state);
    setTrackedState(state);
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
    emit(projectDir, state, 'workflow_started');
  }

  const context: ProjectContext = {
    name: readProjectName(projectDir),
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand,
  };

  const wctx: WorkflowContext = { projectDir, config, callbacks, planner, context, implementer };

  return { ok: true, state, wctx };
}

async function runFinalReviewPhase(
  opts: { projectDir: string; callbacks: OrchestratorCallbacks; state: WorkflowState },
  summaryBase: SummaryBase,
  taskBreakdowns: TaskTokenUsage[],
): Promise<Summary> {
  let { state } = opts;
  const { projectDir, callbacks } = opts;

  state = transition(state, { type: 'ALL_DONE' });
  saveState(projectDir, state);
  const finalReviewStart = Date.now();
  callbacks.onEvent({ type: 'planner-status', ts: finalReviewStart, phase: state.phase, status: 'running' });
  emit(projectDir, state, 'all_tasks_done');

  try {
    const reviewResult = await runFinalReview(projectDir, callbacks);
    writeSpecFile(projectDir, 'review.md', reviewResult.text);
    state = addUsageAndSave(projectDir, state, 'planner', reviewResult.usage);
  } catch (err) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Final review failed: ${toErrorMessage(err)}` });
  }

  state = transition(state, { type: 'REVIEW_DONE' });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done', duration: Date.now() - finalReviewStart });
  emit(projectDir, state, 'workflow_complete');

  const summary = buildSummary({ ...summaryBase, state, taskBreakdowns });
  callbacks.onComplete(summary);
  return summary;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const summaryBase: SummaryBase = { feature, startTime, plannerTool: config.planner.tool, implementerProvider: config.implementer.provider };
  let trackedState: WorkflowState | undefined;
  let currentTask: { file: string; action: string } | undefined;
  let result: Summary | undefined;

  const shutdown = () => {
    killAllProcesses();
    if (trackedState) {
      try { saveState(projectDir, trackedState); } catch { /* best-effort */ }
    }
    if (currentTask) {
      try { discardTaskChanges(projectDir, currentTask.file, currentTask.action as 'create' | 'modify'); } catch { /* best-effort */ }
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

      const taskResult = await runTaskLoop({
        wctx, initialState: state,
        setTrackedState: (s) => { trackedState = s; },
        setCurrentTask: (t) => { currentTask = t; },
      });

      result = await runFinalReviewPhase(
        { projectDir, callbacks, state: taskResult.state },
        summaryBase, taskResult.taskBreakdowns,
      );
    } catch (err) {
      const msg = toErrorMessage(err);
      if (trackedState) {
        try {
          trackedState = transition(trackedState, { type: 'CANCEL' });
          saveState(projectDir, trackedState);
        } catch { /* best-effort */ }
      }
      killAllProcesses();
      callbacks.onEvent({ type: 'error', ts: Date.now(), message: msg });
      result = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
    }
  });

  return result!;
}
