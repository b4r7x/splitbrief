import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { dueCriterionIds } from '../../../core/review/verdict.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { WorkflowContext } from '../types.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { formatValidationError, validationFailureLine } from '../validation/format-error.js';
import { acceptValidationResults, type ValidationAcceptance } from '../validation/acceptance.js';
import type { ValidationResult } from '../validation/result.js';
import { checkRegistry, type CheckRunResult } from '../validation/run-checks.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runPreValidationGate } from './pre-validation-gate.js';
import { runTaskChecks } from './task-checks.js';

type BriefGateContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal' | 'validator'
>;

export function verifyFailures(
  validationResults: ValidationResult[],
  acceptance: ValidationAcceptance,
  checkRuns: readonly CheckRunResult[],
): string[] {
  const failures: string[] = [];
  const stageError = formatValidationError(validationResults, acceptance);
  if (stageError !== '') failures.push(stageError);
  for (const run of checkRuns) {
    if (run.status === 'pass') continue;
    failures.push(`check ${run.checkId} did not pass (${run.status}): ${run.output}`);
  }
  return failures;
}

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
  // A reopened brief rechecks what failed at the pre-review on top of what its cadence runs.
  const failure = state.lineages?.[lineageIdOf(task)]?.gateFailure;
  const cadence = wctx.config.workflow.review ?? 'end';
  const stages: ValidationStage[] = [
    ...new Set([...(cadence === 'task' ? ['test' as const] : []), ...(failure?.stages ?? [])]),
  ].filter((stage) => wctx.config.validation[stage]);
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
      ...(failure?.checkIds ?? []),
      ...(opts.checkIds ?? []),
    ]),
  ];
  const files = [...new Set([...changedFiles, ...(failure?.files ?? [])])];
  const validationOptions = {
    task,
    projectDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    discoveredValidation: state.discoveredValidation,
    signal: wctx.signal,
    changedFiles,
  };
  await wctx.validator.formatChangedFiles(validationOptions);
  let validationResults: ValidationResult[] = [];
  let runs: CheckRunResult[] = [];
  if (stages.length > 0 || checkIds.length > 0) {
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
        validationResults,
        acceptance: {
          accepted: false,
          exemptStages: [],
          blockingStages: [],
        } satisfies ValidationAcceptance,
        error: '',
        diagnosis: '',
      };
    validationResults = await wctx.validator.runValidation({
      ...validationOptions,
      phase: state.phase,
      stages,
      changedFiles: files,
      baseline: state.fullSuiteBaseline,
      testMode: failure?.stages.includes('test') ? 'check' : 'related',
    });
    await recordCheckRuns({ ...wctx, state, task, validation: validationResults });
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
  }
  const stageAcceptance = acceptValidationResults(
    validationResults,
    state.fullSuiteBaseline,
    files,
  );
  const registry = checkRegistry({ task, tasks: state.tasks, plan: state.plan });
  const selected = new Set(opts.checkIds ?? []);
  const failedChecks = runs.filter((run) =>
    selected.has(run.checkId)
      ? run.status !== 'pass'
      : run.status === 'fail' && registry.get(run.checkId)?.required === true,
  );
  const acceptance: ValidationAcceptance = {
    ...stageAcceptance,
    accepted: stageAcceptance.accepted && failedChecks.length === 0 && !wctx.signal?.aborted,
  };
  const firstFailedCheck = failedChecks[0];
  return {
    state,
    stop: wctx.signal?.aborted ? ('aborted' as const) : undefined,
    validationResults,
    acceptance,
    error: verifyFailures(validationResults, acceptance, failedChecks).join('\n\n'),
    diagnosis:
      validationFailureLine(validationResults, acceptance) ||
      (firstFailedCheck === undefined ? '' : `check ${firstFailedCheck.checkId} failed`),
  };
}
