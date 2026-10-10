import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { dueCriterionIds } from '../../../core/review/verdict.js';
import { fixCheckKeys } from '../../../core/review/fix-task.js';
import type { WorkflowContext } from '../types.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import { checkFailureText } from '../validation/failure-text.js';
import { checkRegistry, type CheckRunResult } from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runPreValidationGate } from './pre-validation-gate.js';
import { runTaskChecks } from './task-checks.js';

type BriefGateContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal' | 'validator'
>;

export async function runBriefGate(opts: {
  wctx: BriefGateContext;
  state: WorkflowState;
  task: Task;
  changedFiles: readonly string[];
  /** What `changedFiles` are measured from: a pre_validation deny restores them to it. */
  taskStartSnapshot: ChangedFilesSnapshot | null;
  /** Checks the caller selected: each must pass, whatever its status or `required` flag. */
  checkIds?: readonly string[] | undefined;
  runCommand?: ValidationCommandRunner | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}) {
  const { wctx, task, changedFiles } = opts;
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
  await wctx.validator.formatChangedFiles({
    task,
    projectDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    signal: wctx.signal,
    changedFiles,
  });
  let runs: CheckRunResult[] = [];
  let settled: ReadonlySet<string> = new Set();
  if (checkIds.length > 0) {
    const pre = await runPreValidationGate({
      wctx,
      state,
      task,
      taskChangedFiles: [...changedFiles],
      taskStartSnapshot: opts.taskStartSnapshot,
      setTrackedState: track,
    });
    state = pre.state;
    if (!pre.proceed)
      return {
        state,
        stop: 'skipped' as const,
        acceptance: { accepted: false } satisfies ValidationAcceptance,
        error: '',
        diagnosis: '',
      };
    const checked = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds,
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
  const acceptance: ValidationAcceptance = {
    accepted: failedChecks.length === 0 && !wctx.signal?.aborted,
  };
  const carried = fixCheckKeys(task);
  const firstFailedCheck = failedChecks[0];
  return {
    state,
    stop: wctx.signal?.aborted ? ('aborted' as const) : undefined,
    acceptance,
    error: failedChecks
      .map((run) => checkFailureText(run, { carried: carried.get(run.checkId) }))
      .join('\n\n'),
    diagnosis: firstFailedCheck === undefined ? '' : `check ${firstFailedCheck.checkId} failed`,
  };
}
