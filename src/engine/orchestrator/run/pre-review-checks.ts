import type { Check, Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { reviewScopeFor, type ReviewScope } from '../../../core/review/verdict.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { nowIso } from '../../../utils/format-time.js';
import { planCheckRow, publishError, publishReviewCheck, unranCheckRow } from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { recordTaskCheckRuns } from '../task/task-checks.js';
import {
  buildRequiredChecksUnrunnableRecoveryIssue,
  type UnrunnableCheck,
} from '../recovery/builders/checks.js';
import type { EventBus } from '../../events/types.js';
import type { WorkflowContext } from '../types.js';
import { failingFilesFromKeys, fileOwnerSentence } from '../task/file-owner.js';
import {
  checkRegistry,
  planApprovesNpmScripts,
  createCheckRunner,
  type CheckRunResult,
  type RunChecksOptions,
} from '../validation/run-checks.js';
import { checkFailureText, failureKeysForFile } from '../validation/failure-text.js';
import { throwIfAborted } from '../../../utils/abort.js';
import type { ValidationCommandRunner } from '../validation/types.js';

/** A required check that did not pass: `fail` is a defect, everything else cannot run. */
export function classifyRequiredChecks(runs: readonly CheckRunResult[]): {
  failed: CheckRunResult[];
  unrunnable: UnrunnableCheck[];
} {
  const failed: CheckRunResult[] = [];
  const unrunnable: UnrunnableCheck[] = [];
  for (const run of runs) {
    if (run.status === 'fail') failed.push(run);
    else if (run.status !== 'pass') {
      unrunnable.push({
        checkId: run.checkId,
        output: run.output,
        ...(run.missingProgram === true && { missingProgram: true }),
      });
    }
  }
  return { failed, unrunnable };
}

/**
 * The failures the pre-review hands the reviewer: every required check that ran and failed. Each
 * carries the path into the run registry so the fix task knows the file it owns.
 */
export function buildPreReviewInputs(input: {
  failed: readonly CheckRunResult[];
  registry: ReadonlyMap<string, Check>;
  tasks: readonly Task[];
  ledger: EvidenceLedger | null;
  workspaceDir: string;
}): TriageInput[] {
  const inputs: TriageInput[] = [];
  for (const run of input.failed) {
    const check = input.registry.get(run.checkId);
    const keys = run.status === 'fail' ? run.failure.keys : [];
    const named = failingFilesFromKeys(keys, input.workspaceDir);
    const files =
      named.length > 0
        ? named
        : check?.kind === 'test'
          ? [normalizeProjectRelativePath(check.value)]
          : [null];
    for (const file of files) {
      const owner = fileOwnerSentence(input.ledger, input.tasks, file);
      const failureKeys = failureKeysForFile({
        failure: run.status === 'fail' ? run.failure : null,
        file,
      });
      inputs.push({
        id: `P${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `${owner === undefined ? '' : `${owner}\n`}Required ${checkFailureText(run, { file })}`,
        checkIds: [run.checkId],
        ...(run.command !== undefined && { command: run.command }),
        output: run.output,
        ...(failureKeys.length > 0 && { failureKeys }),
        ...(run.status === 'fail' && { redKeys: run.failure.keys }),
      });
    }
  }
  return inputs;
}

export type RunPreReviewChecksOptions = {
  state: WorkflowState;
  workspaceDir: string;
  projectDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  phase: Phase;
  npmScriptsApproved: boolean;
  /** The review the checks come before; a task review runs only the required checks it covers. */
  scope?: ReviewScope['kind'] | undefined;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
};

export type PreReviewChecks = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
  /** The required checks that ran and failed. */
  failed: CheckRunResult[];
  defects: TriageInput[];
  unrunnable: UnrunnableCheck[];
}>;

/**
 * The candidate verification a review runs first. The final review runs every check of the
 * combined task and run registry; a task review runs the required checks of its briefs and due
 * criteria. Checks are recorded on their declaring task (plan checks on the last task the review
 * covers). Only required checks decide check defects and unrunnable halts.
 */
export async function runPreReviewChecks(
  opts: RunPreReviewChecksOptions,
): Promise<PreReviewChecks> {
  const registry = checkRegistry({ plan: opts.state.plan, tasks: opts.state.tasks });
  const scope = reviewScopeFor(opts.state, opts.scope ?? 'final');
  const covered = new Set([
    ...opts.state.tasks
      .filter((task) => scope.taskIds.includes(task.id))
      .flatMap((task) => (task.checks ?? []).map((check) => check.id)),
    ...(opts.state.plan?.criteria ?? [])
      .filter((criterion) => scope.criterionIds.includes(criterion.id))
      .flatMap((criterion) => criterion.checkIds),
  ]);
  const checks = [...registry.values()].filter(
    (check) => scope.kind === 'final' || (check.required && covered.has(check.id)),
  );
  const checkOptions: RunChecksOptions = {
    plan: opts.state.plan,
    tasks: opts.state.tasks,
    projectDir: opts.workspaceDir,
    sessionId: opts.sessionId,
    checkoutDir: opts.projectDir,
    config: opts.config,
    bus: opts.bus,
    phase: opts.phase,
    npmScriptsApproved: opts.npmScriptsApproved,
    discoveredValidation: opts.state.discoveredValidation,
    signal: opts.signal,
    runCommand: opts.runCommand,
  };
  const notices = { bus: opts.bus, phase: opts.phase };
  const prepare = createCheckRunner(checkOptions);
  const runs: CheckRunResult[] = [];
  for (const check of checks) {
    throwIfAborted(opts.signal);
    const prepared = prepare(check);
    const identity = planCheckRow(check.id, prepared.command, check);
    const startedAt = Date.now();
    publishReviewCheck(notices, { ...identity, status: 'running' });
    const run = await prepared.run();
    runs.push(run);
    publishReviewCheck(notices, {
      ...identity,
      command: run.command ?? prepared.command,
      ...(run.status === 'pass' || run.status === 'fail'
        ? {
            status: 'done',
            passed: run.status === 'pass',
            duration: Date.now() - startedAt,
          }
        : unranCheckRow(run)),
    });
  }
  const { failed, unrunnable } = classifyRequiredChecks(
    runs.filter((run) => registry.get(run.checkId)?.required === true),
  );
  const defects = buildPreReviewInputs({
    failed,
    registry,
    tasks: opts.state.tasks,
    ledger: readEvidenceLedger({ projectDir: opts.projectDir, sessionId: opts.sessionId }),
    workspaceDir: opts.workspaceDir,
  });
  let state = opts.state;
  const lastTaskId = scope.taskIds.at(-1);
  for (const task of state.tasks) {
    const owned = runs.filter(
      (run) =>
        (task.checks ?? []).some((check) => check.id === run.checkId) ||
        (task.id === lastTaskId &&
          (state.plan?.checks ?? []).some((check) => check.id === run.checkId)),
    );
    if (owned.length === 0) continue;
    state = await recordTaskCheckRuns({ wctx: opts, state, task, runs: owned });
  }
  return { state, runs, failed, defects, unrunnable };
}

export type PreReviewResult = Readonly<{
  state: WorkflowState;
  kind: 'review' | 'stopped';
}>;

export function haltRequiredChecksUnrunnable(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  checks: readonly UnrunnableCheck[];
  setTrackedState: (s: WorkflowState) => void;
}): WorkflowState {
  const { wctx, state, checks, setTrackedState } = args;
  const issue = buildRequiredChecksUnrunnableRecoveryIssue({
    phase: state.phase,
    checks,
    createdAt: nowIso(),
  });
  publishError({
    bus: wctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: { category: 'recovery', code: 'required_checks_unrunnable' },
  });
  return raisePendingRecovery(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus },
    state,
    issue,
    setTrackedState,
  );
}

export async function runPreReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  inputs?: readonly TriageInput[] | undefined;
  scope?: ReviewScope['kind'] | undefined;
}): Promise<PreReviewResult> {
  const { wctx, setTrackedState } = args;
  let state = args.state;
  const checks = await runPreReviewChecks({
    state,
    workspaceDir: wctx.workspaceDir,
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
    scope: args.scope,
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
  });
  state = checks.state;
  setTrackedState(state);

  if (checks.unrunnable.length > 0) {
    state = haltRequiredChecksUnrunnable({
      wctx,
      state,
      checks: checks.unrunnable,
      setTrackedState,
    });
    return { state, kind: 'stopped' };
  }

  const inputs = [...(args.inputs ?? []), ...checks.defects];
  if (inputs.length > 0) {
    state = transitionAndSave(wctx, state, { type: 'QUEUE_TRIAGE', inputs });
    setTrackedState(state);
  }
  return { state, kind: 'review' };
}
