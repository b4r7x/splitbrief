import { runBaseOf } from '../isolation/base-tree.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { nowIso } from '../../../utils/format-time.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { publishError } from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { recordTaskCheckRuns } from '../task/task-checks.js';
import {
  buildRequiredChecksUnrunnableRecoveryIssue,
  type UnrunnableCheck,
} from '../recovery/builders/checks.js';
import type { EventBus } from '../../events/types.js';
import type { WorkflowContext } from '../types.js';
import {
  buildFullSuiteInputs,
  failingFilesFromOutput,
  lastTaskChangingFile,
} from '../task/file-owner.js';
import {
  checkRegistry,
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
} from '../validation/run-checks.js';
import type {
  RunFullSuiteResult,
  ValidationCommandRunner,
  Validator,
} from '../validation/types.js';

/** A required check that did not pass: `fail` is a defect, everything else cannot run. */
export function classifyRequiredChecks(runs: readonly CheckRunResult[]): {
  failed: CheckRunResult[];
  unrunnable: UnrunnableCheck[];
} {
  const failed: CheckRunResult[] = [];
  const unrunnable: UnrunnableCheck[] = [];
  for (const run of runs) {
    if (run.status === 'fail') failed.push(run);
    else if (run.status !== 'pass') unrunnable.push({ checkId: run.checkId, output: run.output });
  }
  return { failed, unrunnable };
}

/**
 * The failures the pre-review hands the reviewer: every new full-suite failure, then every required check that ran and failed. Each carries
 * the path into the run registry so the fix task knows the file it owns.
 */
export function buildPreReviewInputs(input: {
  suite: RunFullSuiteResult;
  failed: readonly CheckRunResult[];
  registry: ReadonlyMap<string, Check>;
  tasks: readonly Task[];
  ledger: EvidenceLedger | null;
  workspaceDir: string;
}): TriageInput[] {
  const inputs = buildFullSuiteInputs({
    suite: input.suite,
    tasks: input.tasks,
    ledger: input.ledger,
  });
  for (const run of input.failed) {
    const check = input.registry.get(run.checkId);
    const named = failingFilesFromOutput(run.output, input.workspaceDir);
    const files =
      named.length > 0
        ? named
        : check?.kind === 'test'
          ? [normalizeProjectRelativePath(check.value)]
          : [null];
    for (const file of files) {
      const owner =
        file === null ? undefined : lastTaskChangingFile(input.ledger, input.tasks, file);
      inputs.push({
        id: `P${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `Required check ${run.checkId} failed: ${run.output} ${
          owner === undefined ? 'No task changed it.' : `Last changed by ${owner}.`
        }`,
        checkIds: [run.checkId],
        output: run.output,
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
  validator: Pick<Validator, 'runFullSuite'>;
  npmScriptsApproved: boolean;
  signal?: AbortSignal | undefined;
  runCommand?: ValidationCommandRunner | undefined;
};

export type PreReviewChecks = Readonly<{
  state: WorkflowState;
  suite: RunFullSuiteResult;
  runs: CheckRunResult[];
  /** The required checks that ran and failed. */
  failed: CheckRunResult[];
  defects: TriageInput[];
  unrunnable: UnrunnableCheck[];
}>;

/**
 * The candidate verification the final review runs first: the full suite and every
 * check of the combined task and run registry. A red stage is re-run at the run
 * base; only new failures become defects. Checks are recorded on their declaring
 * task (plan checks on the last task). Only required checks decide check defects
 * and unrunnable halts.
 */
export async function runPreReviewChecks(
  opts: RunPreReviewChecksOptions,
): Promise<PreReviewChecks> {
  const registry = checkRegistry({ plan: opts.state.plan, tasks: opts.state.tasks });
  const ids = [...registry.keys()];
  const suite = await opts.validator.runFullSuite({
    projectDir: opts.workspaceDir,
    config: opts.config,
    bus: opts.bus,
    phase: opts.phase,
    discoveredValidation: opts.state.discoveredValidation,
    signal: opts.signal,
    base: runBaseOf(opts, opts.state),
  });
  const runs =
    ids.length === 0 || Object.values(suite.newFailures).some((keys) => keys.length > 0)
      ? []
      : await runChecks(ids, {
          plan: opts.state.plan,
          tasks: opts.state.tasks,
          projectDir: opts.workspaceDir,
          sessionId: opts.sessionId,
          checkoutDir: opts.projectDir,
          config: opts.config,
          bus: opts.bus,
          phase: opts.phase,
          npmScriptsApproved: opts.npmScriptsApproved,
          ...(opts.state.discoveredValidation !== undefined && {
            discoveredValidation: opts.state.discoveredValidation,
          }),
          ...(opts.signal !== undefined && { signal: opts.signal }),
          ...(opts.runCommand !== undefined && { runCommand: opts.runCommand }),
        });
  const { failed, unrunnable } = classifyRequiredChecks(
    runs.filter((run) => registry.get(run.checkId)?.required === true),
  );
  const defects = buildPreReviewInputs({
    suite,
    failed,
    registry,
    tasks: opts.state.tasks,
    ledger: readEvidenceLedger({ projectDir: opts.projectDir, sessionId: opts.sessionId }),
    workspaceDir: opts.workspaceDir,
  });
  let state = opts.state;
  const lastTaskId = state.tasks.at(-1)?.id;
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
  return { state, suite, runs, failed, defects, unrunnable };
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

/**
 * The last completed brief is the ledger entry the pre-review checks attach to.
 */
async function recordPreReviewChecks(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  checks: PreReviewChecks;
}): Promise<void> {
  const { wctx, state, checks } = args;
  const task = state.tasks.at(-1);
  if (task === undefined) return;
  // A pre-review that neither ran a stage nor a check has nothing to log; creating
  // the ledger for it would otherwise invent evidence.json for a run that had none.
  if (checks.runs.length === 0 && checks.suite.results.length === 0) return;
  await recordCheckRuns({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspaceDir: wctx.workspaceDir,
    state,
    task,
    validation: checks.suite.results,
  });
}

export async function runPreReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  inputs?: readonly TriageInput[] | undefined;
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
    validator: wctx.validator,
    npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
  });
  state = checks.state;
  setTrackedState(state);
  await recordPreReviewChecks({ wctx, state, checks });

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
