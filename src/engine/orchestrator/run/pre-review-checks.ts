import type { Check, Task } from '../../../core/schemas/task.js';
import { fixCyclesOf, type WorkflowState } from '../../../core/schemas/workflow.js';
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
import { verifyFailures } from '../task/brief-gate.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import {
  buildRequiredChecksUnrunnableRecoveryIssue,
  type UnrunnableCheck,
} from '../recovery/builders/checks.js';
import { haltUnansweredTriage, runTriage, startFixCycle } from '../triage.js';
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
  FullSuiteFailureKeys,
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
 * The failures the pre-review hands the triage: new full-suite failures, keyed by
 * the file they name, then every required check that ran and failed. Each carries
 * the path into the run registry so the fix task knows the file it owns.
 */
export function buildPreReviewInputs(input: {
  newFailures: FullSuiteFailureKeys;
  failed: readonly CheckRunResult[];
  registry: ReadonlyMap<string, Check>;
  tasks: readonly Task[];
  ledger: EvidenceLedger | null;
  workspaceDir: string;
}): TriageInput[] {
  const inputs = buildFullSuiteInputs({
    newFailures: input.newFailures,
    tasks: input.tasks,
    ledger: input.ledger,
  });
  const push = (file: string | null, text: string): void => {
    inputs.push({ id: `P${inputs.length + 1}`, kind: 'defect', source: 'check', file, text });
  };
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
      push(
        file,
        `Required check ${run.checkId} failed: ${run.output} ${
          owner === undefined ? 'No task changed it.' : `Last changed by ${owner}.`
        }`,
      );
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
 * The candidate verification the final review runs first: the full suite, baseline
 * relative, and every check of the combined task and run registry, each recorded on
 * the task that declares it (plan checks on the last task). Only required checks
 * decide defects and unrunnable halts.
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
    moment: 'pre-review',
    discoveredValidation: opts.state.discoveredValidation,
    signal: opts.signal,
    baseline: opts.state.fullSuiteBaseline,
    baselineStages: opts.state.fullSuiteBaselineStages,
  });
  const runs =
    ids.length === 0
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
    newFailures: suite.newFailures,
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
  kind: 'review' | 'fix-queued' | 'stopped';
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

/**
 * Before the final review: run the suite and the checks on the candidate. A required
 * check that cannot run halts. A red whose every failure names a file last changed by
 * one completed brief reopens that brief into its retry ladder with the exact errors;
 * any other red enters the triage as defects. The reopen and the triage each spend
 * one fix cycle.
 */
export async function runPreReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
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

  if (checks.defects.length === 0) return { state, kind: 'review' };

  const cycles = fixCyclesOf(state);
  if (cycles.used >= cycles.allowance) {
    const issue = buildReviewFailedRecoveryIssue({
      phase: state.phase,
      blocking: checks.defects.length,
      fixCycles: cycles.used,
      createdAt: nowIso(),
    });
    publishError({ bus: wctx.bus, phase: state.phase, message: issue.message });
    state = raisePendingRecovery(
      { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus },
      state,
      issue,
      setTrackedState,
    );
    return { state, kind: 'stopped' };
  }

  const ledger = readEvidenceLedger({ projectDir: wctx.projectDir, sessionId: wctx.sessionId });
  const owners = checks.defects.map((defect) =>
    defect.file === null ? undefined : lastTaskChangingFile(ledger, state.tasks, defect.file),
  );
  const owner = owners[0];
  if (
    owner !== undefined &&
    owners.every((candidate) => candidate === owner) &&
    checks.failed.every((run) => failingFilesFromOutput(run.output, wctx.workspaceDir).length > 0)
  ) {
    const stages = checks.suite.results
      .filter((result) => checks.suite.newFailures[result.stage] !== undefined)
      .map((result) => result.stage);
    const output = verifyFailures(
      checks.suite.results,
      { accepted: false, exemptStages: [], blockingStages: stages },
      checks.failed,
    ).join('\n\n');
    state = transitionAndSave(wctx, state, {
      type: 'REOPEN_TASK',
      taskId: owner,
      failure: {
        output,
        stages,
        files: checks.defects.flatMap((defect) => (defect.file === null ? [] : [defect.file])),
        checkIds: checks.failed.map((run) => run.checkId),
      },
    });
    setTrackedState(state);
    wctx.bus.publish({ type: 'task_reset', ts: Date.now(), phase: state.phase, taskId: owner });
    state = startFixCycle({ wctx, state, setTrackedState, taskIds: [owner] });
    return { state, kind: 'fix-queued' };
  }

  const triaged = await runTriage(
    {
      projectDir: wctx.projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId: wctx.sessionId,
      bus: wctx.bus,
      config: wctx.config,
      planner: wctx.planner,
      callbacks: wctx.callbacks,
      sinks: wctx.sinks,
      state,
      ...(wctx.signal !== undefined && { signal: wctx.signal }),
      onStateChange: (next) => {
        state = next;
        setTrackedState(next);
      },
    },
    { inputs: checks.defects },
  );
  if (triaged.kind !== 'triaged') {
    state = haltUnansweredTriage({
      wctx,
      state,
      outcome: triaged,
      setTrackedState,
      diagnosis: 'The pre-review checks found failures to triage.',
      source: 'pre-review',
    });
    return { state, kind: 'stopped' };
  }
  state = startFixCycle({
    wctx,
    state,
    setTrackedState,
    taskIds: triaged.tasks.map((task) => task.id),
  });
  return { state, kind: 'fix-queued' };
}
