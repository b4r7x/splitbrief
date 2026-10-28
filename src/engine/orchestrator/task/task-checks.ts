import {
  fileFromFailureKey,
  fixCheckCounts,
  fixCheckKeys,
  fixReviewChecks,
  isTestNodeKey,
  judgeFixCheck,
  type FixCheckKeys,
} from '../../../core/review/fix-task.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import {
  planCheckRow,
  publishChecksRun,
  publishReviewCheck,
  publishTaskValidating,
  unranCheckRow,
} from '../events.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { runReviewCheck } from '../review-checks.js';
import {
  checkRegistry,
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
  type RunChecksOptions,
} from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { withAttemptRestoreScope } from './restore-scope.js';

export type TaskChecksResult = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
  /** The red checks whose own failures are gone, or left to an unfinished sibling fix task. */
  settled: ReadonlySet<string>;
}>;

type TaskChecksContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal'
>;

/** Per carried check whose own failures are all test failures, the test files they name. */
function ownTestFiles(carried: ReadonlyMap<string, FixCheckKeys>): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const [id, { failureKeys }] of carried) {
    if (failureKeys.length === 0 || !failureKeys.every(isTestNodeKey)) continue;
    files.set(id, [...new Set(failureKeys.flatMap((key) => fileFromFailureKey(key) ?? []))]);
  }
  return files;
}

/**
 * The options a brief's checks run under. Reviewer commands come from the fix task's findings,
 * under the same command policy, with the run base for changed-script refusal. A check whose own
 * failures are all test failures runs only their test files.
 */
function taskCheckOptions(opts: {
  wctx: TaskChecksContext;
  state: WorkflowState;
  task: Task;
  carried: ReadonlyMap<string, FixCheckKeys>;
  runCommand?: ValidationCommandRunner | undefined;
  rerunRedBefore?: string | undefined;
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
    testFiles: ownTestFiles(opts.carried),
    results: {
      ref: { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
      state,
      tree: 'workspace',
      rerunRedBefore: opts.rerunRedBefore,
    },
    ...(state.discoveredValidation !== undefined && {
      discoveredValidation: state.discoveredValidation,
    }),
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
  };
}

/**
 * Runs the brief's checks and records them. Each judged fix check gets a verdict row, and each
 * check that did not run gets a refused or not-run row with its reason.
 * Reviewer checks also get a running row and clock, with commands from the fix task's findings.
 * A fix check runs once. `settled` names each red whose own failures are gone, or left to an
 * unfinished sibling fix task; failures the brief does not own never gate it.
 */
export async function runTaskChecks(opts: {
  wctx: TaskChecksContext;
  state: WorkflowState;
  task: Task;
  checkIds: readonly string[];
  taskStartSnapshot?: ChangedFilesSnapshot | null | undefined;
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  /** A consult `verify`: a red stored before this time runs again. */
  rerunRedBefore?: string | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<TaskChecksResult> {
  if (opts.checkIds.length === 0) return { state: opts.state, runs: [], settled: new Set() };
  const checked = await withAttemptRestoreScope({
    ref: opts.wctx,
    dir: opts.wctx.workspaceDir,
    taskStartSnapshot: opts.taskStartSnapshot ?? null,
    attemptSnapshot: opts.attemptSnapshot,
    run: () => runTaskCheckCommands(opts),
  });
  const state = await recordTaskCheckRuns({
    ...opts,
    ...checked,
    state: rebaseOnPersistedWorkflowState(opts.wctx, checked.state, { keepUnsaved: true }),
  });
  return { ...checked, state };
}

async function runTaskCheckCommands(
  opts: Parameters<typeof runTaskChecks>[0],
): Promise<TaskChecksResult> {
  const { wctx, task } = opts;
  let state = opts.state;
  const settled = new Set<string>();
  const carried = fixCheckKeys(task, state.tasks);
  const checkOptions = taskCheckOptions({ ...opts, carried });
  const reviewCommands = new Map(
    (checkOptions.reviewChecks ?? []).map((check) => [check.id, check.value]),
  );
  const runs = await runChecks(
    opts.checkIds.filter((id) => !reviewCommands.has(id)),
    checkOptions,
    (check, command) =>
      publishTaskValidating(
        { bus: checkOptions.bus, phase: checkOptions.phase },
        task.id,
        planCheckRow(check.id, command, check),
      ),
  );
  const registry = checkRegistry(checkOptions);
  for (const run of runs) {
    if (run.status !== 'fail' && run.status !== 'pass') {
      publishReviewCheck(
        { bus: checkOptions.bus, phase: checkOptions.phase },
        {
          ...planCheckRow(run.checkId, run.command ?? '', registry.get(run.checkId)),
          ...unranCheckRow(run),
        },
      );
      continue;
    }
    const judged = judgeFixCheck(
      carried.get(run.checkId),
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
        passed: judged.left.length === 0,
        ...(run.reusedAt !== undefined && { reusedAt: run.reusedAt }),
        ...fixCheckCounts(judged),
      },
    );
    if (run.status === 'fail' && judged.left.length === 0) settled.add(run.checkId);
  }
  for (const id of new Set(opts.checkIds)) {
    const command = reviewCommands.get(id);
    if (command === undefined) continue;
    const { run, fresh } = await runReviewCheck({
      check: { id, command },
      moment: 'brief',
      carried: carried.get(id),
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
    status: opts.settled?.has(run.checkId) === true ? ('pass' as const) : run.status,
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
