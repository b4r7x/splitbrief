import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishChecksRun } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import {
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
} from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { recordCheckRuns } from '../evidence/record-checks.js';

export type TaskChecksResult = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
}>;

type TaskChecksContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal'
>;

export async function runTaskChecks(opts: {
  wctx: TaskChecksContext;
  state: WorkflowState;
  task: Task;
  checkIds: readonly string[];
  runCommand?: ValidationCommandRunner | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<TaskChecksResult> {
  const { wctx, task } = opts;
  let state = opts.state;
  const runs: CheckRunResult[] =
    opts.checkIds.length === 0
      ? []
      : await runChecks(opts.checkIds, {
          task,
          plan: state.plan,
          tasks: state.tasks,
          runCommand: opts.runCommand,
          projectDir: wctx.workspaceDir,
          sessionId: wctx.sessionId,
          checkoutDir: wctx.projectDir,
          config: wctx.config,
          bus: wctx.bus,
          phase: state.phase,
          npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
          ...(state.discoveredValidation !== undefined && {
            discoveredValidation: state.discoveredValidation,
          }),
          ...(wctx.signal !== undefined && { signal: wctx.signal }),
        });
  if (runs.length === 0) return { state, runs };
  state = await recordTaskCheckRuns({
    wctx,
    state,
    task,
    runs,
    setTrackedState: opts.setTrackedState,
  });
  return { state, runs };
}

/** Each run lands on the task's state, on the bus and in the evidence ledger. */
export async function recordTaskCheckRuns(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  runs: readonly CheckRunResult[];
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<WorkflowState> {
  const { wctx, task, runs } = opts;
  const checkResults = runs.map((run) => ({ id: run.checkId, passed: run.status === 'pass' }));
  const state = transitionAndSave(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    opts.state,
    { type: 'RECORD_CHECK_RESULTS', taskId: task.id, results: checkResults },
  );
  opts.setTrackedState?.(state);
  publishChecksRun({ bus: wctx.bus, phase: state.phase }, task.id, checkResults);
  await recordCheckRuns({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspaceDir: wctx.workspaceDir,
    state,
    task,
    runs,
  });
  return state;
}
