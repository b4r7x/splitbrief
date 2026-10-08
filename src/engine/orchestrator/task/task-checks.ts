import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishChecksRun } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { splitAtRunBase } from '../review-checks.js';
import {
  enabledReviewChecks,
  planApprovesNpmScripts,
  reviewCheckList,
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
 * The options a brief's checks run under. They name the last review's reviewer checks, so a fix
 * task can run the reviewer check it answers again, under the same command policy and run base.
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
    reviewChecks: enabledReviewChecks(wctx.config, state.reviewChecks),
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
 * Runs the brief's checks and records them. A red reviewer check runs again at the run base, as at
 * review: `settled` names each one whose every failure is also red there.
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
    reviewCheckList(checkOptions.reviewChecks).map((check) => [check.id, check.value]),
  );
  const runs: CheckRunResult[] = [];
  for (const run of await runChecks(opts.checkIds, checkOptions)) {
    const command = reviewCommands.get(run.checkId);
    if (run.status !== 'fail' || command === undefined) {
      runs.push(run);
      continue;
    }
    const { fresh, preExisting } = await splitAtRunBase({ run, command, checkOptions });
    if (fresh.length === 0) settled.add(run.checkId);
    runs.push(preExisting.length > 0 ? { ...run, preExisting } : run);
  }
  state = await recordTaskCheckRuns({
    wctx,
    state,
    task,
    runs,
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
