import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { dueCriterionIds } from '../../../core/review/verdict.js';
import { fixCheckKeys } from '../../../core/review/fix-task.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import { checkFailureText } from '../validation/failure-text.js';
import { checkRegistry, type CheckRunResult } from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runPreValidationGate } from './pre-validation-gate.js';
import { runTaskChecks } from './task-checks.js';
import { withAttemptRestoreScope } from './restore-scope.js';

type BriefGateContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal' | 'validator'
>;

export const CORRECTION_AFTER_CHECKS =
  'The operator sent a correction while the checks ran. It is in your steer: apply it, then hand back.';

export async function runBriefGate(opts: {
  wctx: BriefGateContext;
  state: WorkflowState;
  task: Task;
  changedFiles: readonly string[];
  /** A pre_validation denial restores the task's recorded writes to this baseline. */
  taskStartSnapshot: ChangedFilesSnapshot | null;
  attemptSnapshot?: ChangedFilesSnapshot | undefined;
  /** Checks the caller selected: each must pass, whatever its status or `required` flag. */
  checkIds?: readonly string[] | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}) {
  const { wctx, task, changedFiles } = opts;
  const runScoped = <T>(run: () => Promise<T>): Promise<T> =>
    withAttemptRestoreScope({
      ref: wctx,
      dir: wctx.workspaceDir,
      taskStartSnapshot: opts.taskStartSnapshot,
      attemptSnapshot: opts.attemptSnapshot,
      run,
    });
  let state = opts.state;
  const track = opts.setTrackedState ?? (() => {});
  // A fix task runs the checks of the red it answers again on top of what its cadence runs.
  const fixCheckIds = new Set(
    (task.fix?.findings ?? []).flatMap((finding) => finding.checkIds ?? []),
  );
  const cadence = wctx.config.workflow.review ?? 'end';
  const due = new Set(dueCriterionIds(state, task.id));
  const checkIds = [
    ...new Set([
      ...(cadence === 'task'
        ? [
            ...(task.checks ?? []).map((check) => check.id),
            ...(state.plan?.criteria ?? [])
              .filter(
                (criterion) =>
                  due.has(criterion.id) && (task.criteria ?? []).includes(criterion.id),
              )
              .flatMap((criterion) => criterion.checkIds),
          ]
        : []),
      ...fixCheckIds,
      ...(opts.checkIds ?? []),
    ]),
  ];
  await runScoped(() =>
    wctx.validator.formatChangedFiles({
      task,
      projectDir: wctx.workspaceDir,
      config: wctx.config,
      bus: wctx.bus,
      phase: state.phase,
      signal: wctx.signal,
      changedFiles,
    }),
  );
  state = rebaseOnPersistedWorkflowState(wctx, state, { keepUnsaved: true });
  let runs: CheckRunResult[] = [];
  let settled: ReadonlySet<string> = new Set();
  if (checkIds.length > 0) {
    const pre = await runPreValidationGate({
      wctx,
      state,
      task,
      taskStartSnapshot: opts.taskStartSnapshot,
      attemptSnapshot: opts.attemptSnapshot,
      setTrackedState: track,
    });
    state = pre.state;
    if (!pre.proceed)
      return {
        state,
        stop: 'skipped' as const,
        correction: false,
        acceptance: { accepted: false } satisfies ValidationAcceptance,
        error: '',
        diagnosis: '',
      };
    const checked = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds,
      taskStartSnapshot: opts.taskStartSnapshot,
      attemptSnapshot: opts.attemptSnapshot,
      runCommand: opts.runCommand,
      setTrackedState: track,
    });
    state = checked.state;
    runs = checked.runs;
    settled = checked.settled;
  }
  const registry = checkRegistry({ task, tasks: state.tasks, plan: state.plan });
  const selected = new Set(opts.checkIds ?? []);
  const failedChecks = runs.filter((run) =>
    selected.has(run.checkId) || fixCheckIds.has(run.checkId)
      ? run.status !== 'pass' && !settled.has(run.checkId)
      : run.status === 'fail' &&
        !settled.has(run.checkId) &&
        registry.get(run.checkId)?.required === true,
  );
  const checksAccepted = failedChecks.length === 0 && !wctx.signal?.aborted;
  state = rebaseOnPersistedWorkflowState(wctx, state, { keepUnsaved: true });
  track(state);
  const correction = checksAccepted && state.messageQueue.some(isQueuedMessagePendingDelivery);
  const acceptance: ValidationAcceptance = { accepted: checksAccepted && !correction };
  const carried = fixCheckKeys(task);
  const firstFailedCheck = failedChecks[0];
  return {
    state,
    stop: wctx.signal?.aborted ? ('aborted' as const) : undefined,
    correction,
    acceptance,
    error: correction
      ? CORRECTION_AFTER_CHECKS
      : failedChecks
          .map((run) => checkFailureText(run, { carried: carried.get(run.checkId) }))
          .join('\n\n'),
    diagnosis: firstFailedCheck === undefined ? '' : `check ${firstFailedCheck.checkId} failed`,
  };
}
