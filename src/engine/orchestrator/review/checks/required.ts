import { readEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import { type ReviewScope, reviewScopeFor } from '../../../../core/review/scope.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type { TriageInput } from '../../../../core/schemas/review/verdict.js';
import type { Check, Task } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import { capitalize } from '../../../../utils/capitalize.js';
import { normalizeProjectRelativePath } from '../../../../utils/path/patterns.js';
import type { EventBus } from '../../../events/types.js';
import { runBaseOf } from '../../isolation/run-base/tree.js';
import type { UnrunnableCheck } from '../../recovery/builders/checks.js';
import { recordTaskCheckRuns } from '../../task/checks.js';
import { failingFilesFromKeys, fileOwnerSentence } from '../../task/file-owner.js';
import type { BaseGate } from '../../validation/base-gate.js';
import {
  newFailureKeys,
  failureKeysForFile,
  checkFailureText,
} from '../../validation/failure-text.js';
import { createCheckRunner } from '../../validation/checks/runner.js';
import { checkRegistry } from '../../validation/checks/runner.js';
import type { CheckRunResult, RunChecksOptions } from '../../validation/checks/types.js';
import type { ValidationCommandRunner } from '../../validation/types.js';
import { runCheckWithRows } from './rows.js';

/** A check that did not pass: `fail` is a defect, everything else cannot run. */
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
 * The failures the pre-review hands the reviewer: every check that ran and failed. Each
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
    const keys = newFailureKeys(run);
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
        failure: run.status === 'fail' ? { ...run.failure, keys } : null,
        file,
      });
      inputs.push({
        id: `P${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `${owner === undefined ? '' : `${owner}\n`}${capitalize(checkFailureText(run, { file }))}`,
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
  /** The review the checks come before; a task review runs only the checks it covers. */
  scope?: ReviewScope['kind'] | undefined;
  /** The project gate at the run base; a red plan check splits by the same command there. */
  baseGate?: BaseGate | undefined;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
};

export type PreReviewChecks = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
  /** The checks that ran and failed. */
  failed: CheckRunResult[];
  defects: TriageInput[];
  unrunnable: UnrunnableCheck[];
}>;

/**
 * The candidate verification a review runs first. The final review runs every check of the
 * combined task and run registry; a task review runs the checks of its briefs and due criteria.
 * Checks are recorded on their declaring task (plan checks on the last task the review covers).
 * Every check that runs decides check defects and unrunnable halts.
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
    (check) => scope.kind === 'final' || covered.has(check.id),
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
    results: {
      ref: { projectDir: opts.projectDir, sessionId: opts.sessionId },
      state: opts.state,
      tree: 'workspace',
    },
  };
  const notices = { bus: opts.bus, phase: opts.phase };
  const prepare = createCheckRunner(checkOptions);
  const base = runBaseOf(opts, opts.state);
  const runs: CheckRunResult[] = [];
  for (const check of checks) {
    throwIfAborted(opts.signal);
    runs.push(
      await runCheckWithRows({
        check,
        prepare,
        notices,
        moment: 'plan',
        baseGate: opts.baseGate,
        base,
      }),
    );
  }
  // A red whose every failure the same command also shows at the run base fails no review.
  const settled = new Set(
    runs
      .filter((run) => run.preExisting !== undefined && newFailureKeys(run).length === 0)
      .map((run) => run.checkId),
  );
  const { failed, unrunnable } = classifyRequiredChecks(
    runs.filter((run) => !settled.has(run.checkId)),
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
    state = await recordTaskCheckRuns({ wctx: opts, state, task, runs: owned, settled });
  }
  return { state, runs, failed, defects, unrunnable };
}
