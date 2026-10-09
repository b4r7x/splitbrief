import { fixCheckKeys, fixReviewChecks, judgeFixCheck } from '../../../core/review/fix-task.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishChecksRun, publishReviewCheck } from '../events.js';
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
  /**
   * The red checks whose carried failures are proven gone from the same failure source.
   */
  settled: ReadonlySet<string>;
}>;

type TaskChecksContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal'
>;

/**
 * The options a brief's checks run under. Reviewer commands come from the fix task's findings,
 * under the same command policy, with the run base for changed-script refusal.
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
 * Runs the brief's checks and records them. Each judged fix check gets a verdict row.
 * Reviewer checks also get a running row and clock, with commands from the fix task's findings.
 * A fix check runs once. `settled` names each red whose carried failures are proven gone.
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
  const carried = fixCheckKeys(task);
  const reviewCommands = new Map(
    (checkOptions.reviewChecks ?? []).map((check) => [check.id, check.value]),
  );
  const runs = await runChecks(
    opts.checkIds.filter((id) => !reviewCommands.has(id)),
    checkOptions,
  );
  for (const run of runs) {
    if (run.status !== 'fail' && run.status !== 'pass') continue;
    const judged = judgeFixCheck(
      carried.get(run.checkId) ?? { failureKeys: [], redKeys: [] },
      run.status === 'fail' ? run.failure : null,
    );
    if (judged === null) continue;
    publishReviewCheck(
      { bus: checkOptions.bus, phase: checkOptions.phase },
      {
        status: 'done',
        id: run.checkId,
        command: run.command ?? run.checkId,
        moment: 'brief',
        passed: judged.left.length === 0 && judged.proven,
        own: judged.own,
        ownLeft: judged.left.length,
        others: judged.others,
        proven: judged.proven,
      },
    );
    if (run.status === 'fail' && judged.left.length === 0 && judged.proven)
      settled.add(run.checkId);
  }
  for (const id of new Set(opts.checkIds)) {
    const command = reviewCommands.get(id);
    if (command === undefined) continue;
    const { run, fresh } = await runReviewCheck({
      check: { id, command },
      moment: 'brief',
      carried: carried.get(id) ?? { failureKeys: [], redKeys: [] },
      checkOptions,
    });
    if (run.status === 'fail' && fresh.length === 0) settled.add(id);
    runs.push(run);
  }
  const ranReviewCommands = runs.flatMap((run) => {
    const command = reviewCommands.get(run.checkId);
    return command !== undefined && (run.status === 'pass' || run.status === 'fail')
      ? [command]
      : [];
  });
  if (ranReviewCommands.length > 0) {
    state = transitionAndSave({ projectDir: wctx.projectDir, sessionId: wctx.sessionId }, state, {
      type: 'SET_PENDING_REVIEW_COMMANDS',
      commands: [...new Set([...(state.pendingReviewCommands ?? []), ...ranReviewCommands])],
    });
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
