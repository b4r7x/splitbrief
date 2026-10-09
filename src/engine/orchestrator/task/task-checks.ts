import { fixReviewChecks } from '../../../core/review/fix-task.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishChecksRun } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { runReviewCheck } from '../review-checks.js';
import {
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
  type RunChecksOptions,
} from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { recordCheckRuns } from '../evidence/record-checks.js';

export type TaskChecksResult = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
  /** The red reviewer checks whose every failure is also red at the run base. */
  settled: ReadonlySet<string>;
}>;

type TaskChecksContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal'
>;

/**
 * The options a brief's checks run under. Reviewer commands come from the fix task's findings,
 * under the same command policy and run base.
 */
function taskCheckOptions(opts: {
  wctx: TaskChecksContext;
  state: WorkflowState;
  task: Task;
  runCommand?: ValidationCommandRunner | undefined;
}): RunChecksOptions {
  const { wctx, state, task } = opts;
  return {
    task,
    plan: state.plan,
    tasks: state.tasks,
    reviewChecks: fixReviewChecks(task),
    base: runBaseOf(wctx, state),
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
  };
}

/**
 * Runs the brief's checks and records them. Each fix reviewer check gets its own row and clock;
 * its command comes from the fix task's findings.
 * A red runs again at the run base: `settled` names each one whose every failure is also red there.
 */
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
  const settled = new Set<string>();
  if (opts.checkIds.length === 0) return { state, runs: [], settled };
  const checkOptions = taskCheckOptions(opts);
  const reviewCommands = new Map(
    (checkOptions.reviewChecks ?? []).map((check) => [check.id, check.value]),
  );
  const runs = await runChecks(
    opts.checkIds.filter((id) => !reviewCommands.has(id)),
    checkOptions,
  );
  for (const id of new Set(opts.checkIds)) {
    const command = reviewCommands.get(id);
    if (command === undefined) continue;
    const { run, fresh } = await runReviewCheck({
      check: { id, command },
      moment: 'brief',
      checkOptions,
    });
    if (run.status === 'fail' && fresh.length === 0) settled.add(id);
    runs.push(run);
  }
  state = await recordTaskCheckRuns({
    wctx,
    state,
    task,
    runs,
    settled,
    setTrackedState: opts.setTrackedState,
  });
  return { state, runs, settled };
}

/** Each run lands on the task's state, on the bus and in the evidence ledger. */
export async function recordTaskCheckRuns(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  runs: readonly CheckRunResult[];
  settled?: ReadonlySet<string> | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<WorkflowState> {
  const { wctx, task, runs } = opts;
  const checkResults = runs.map((run) => ({
    id: run.checkId,
    passed: run.status === 'pass' || opts.settled?.has(run.checkId) === true,
  }));
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
