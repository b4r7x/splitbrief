import { resolveEndChecks } from '../../core/config/runtime/resolve.js';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { fixCheckCounts, judgeFixCheck, type FixCheckKeys } from '../../core/review/fix-task.js';
import type { Config } from '../../core/schemas/config.js';
import type { TriageInput } from '../../core/schemas/review.js';
import type { ReviewRecord, WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../events/types.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { publishReviewCheck, publishReviewChecks } from './events.js';
import { runBaseOf, withRunBaseTree, type RunBase } from './isolation/base-tree.js';
import { runBaseTreeError } from './isolation/errors.js';
import { transitionAndSave } from './state-ops.js';
import { failingFilesFromKeys, fileOwnerSentence } from './task/file-owner.js';
import type { FailureKeys } from './validation/extract-failure-keys.js';
import { checkFailureText, failureKeysForFile, newFailureKeys } from './validation/failure-text.js';
import {
  enabledReviewChecks,
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
  type RunChecksOptions,
} from './validation/run-checks.js';

const REVIEW_CHECK_INPUT_ID = /^V\d+\.\d+$/;

const OFF_SECTION = `## Reviewer checks

End-of-run checks are off in this run's config (validation.end_checks), so SPLITBRIEF ran no reviewer check before this review. Only the plan and task checks ran, and their output is in the Checks Log. Judge only from the recorded evidence; mark a criterion unverified when no recorded evidence proves it.`;

const NO_GATE_SECTION = `## Reviewer checks

The plan names no project gate, so SPLITBRIEF ran no reviewer check before this review. Only the plan and task checks ran, and their output is in the Checks Log. Judge only from the recorded evidence; mark a criterion unverified when no recorded evidence proves it.`;

export type ReviewChecksOptions = {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  state: WorkflowState;
  signal?: AbortSignal | undefined;
};

export type ReviewChecksOutcome = {
  state: WorkflowState;
  section: string;
  /** The gate commands that were red at the run base too, with those failures. */
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>;
};

/** Why two reds whose keys include a placeholder do not show the same failure. */
function notVerifiedReason(workspace: FailureKeys, base: FailureKeys): string {
  if (workspace.placeholder !== undefined && workspace.placeholder === base.placeholder) {
    return `both runs ${workspace.placeholder}`;
  }
  return [
    workspace.placeholder === undefined ? null : `the workspace run ${workspace.placeholder}`,
    base.placeholder === undefined ? null : `the run base re-run ${base.placeholder}`,
  ]
    .filter((side) => side !== null)
    .join(' and ');
}

/**
 * The keys of a red command that the same command text also shows at the run base, or why the
 * re-run at the run base could not tell. A red base re-run proves a pre-existing failure only when
 * both runs name their failures: with a placeholder on either side nothing is pre-existing, and
 * `notVerified` says why. A run base that cannot be prepared leaves every key not verified, with
 * the preparation error and any cleanup error as the reason. Cleanup errors after a completed
 * re-run also leave every key not verified, with the cleanup error visible in the row detail.
 */
async function preExistingKeys(input: {
  id: string;
  command: string;
  failure: FailureKeys;
  base: RunBase;
  checkOptions: RunChecksOptions;
  notices: { bus: EventBus; phase: WorkflowState['phase'] };
}): Promise<{
  keys: string[];
  run?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const startedAt = Date.now();
  publishReviewCheck(input.notices, {
    status: 'running',
    id: input.id,
    command: input.command,
    moment: 'base',
  });
  let atBase: { run: CheckRunResult; incomplete: string | undefined } | undefined;
  let treeError: string | undefined;
  try {
    const completed = await withRunBaseTree(
      input.base,
      input.checkOptions.projectDir,
      async ({ dir, incomplete }) => {
        const { results } = input.checkOptions;
        const [run] = await runChecks([input.id], {
          ...input.checkOptions,
          projectDir: dir,
          base: undefined,
          checkoutDir: undefined,
          results: results === undefined ? undefined : { ...results, tree: 'run-base' },
        });
        return run === undefined ? undefined : { run, incomplete };
      },
    );
    atBase = completed.result;
    treeError = completed.cleanupError;
  } catch (err) {
    if (!runBaseTreeError.isPreparationFailed(err)) throw err;
    treeError = err.message;
  }
  if (treeError !== undefined) {
    publishReviewCheck(input.notices, {
      status: 'done',
      id: input.id,
      command: input.command,
      moment: 'base',
      passed: false,
      detail: treeError,
      duration: Date.now() - startedAt,
      newFailures: 0,
      preExisting: 0,
      notVerified: input.failure.keys.length,
    });
    return { keys: [], notVerified: treeError };
  }
  if (atBase === undefined || (atBase.run.status !== 'pass' && atBase.run.status !== 'fail')) {
    publishReviewCheck(input.notices, {
      status: atBase?.run.status === 'refused' ? 'refused' : 'not-run',
      id: input.id,
      command: input.command,
      moment: 'base',
      detail: atBase?.run.output ?? `no check ${input.id}`,
    });
    return {
      keys: [],
      run: atBase?.run,
      unavailable: `${atBase?.run.status === 'refused' ? 'refused' : 'not run'}: ${atBase?.run.output ?? `no check ${input.id}`}`,
    };
  }
  const baseFailure = atBase.run.status === 'fail' ? atBase.run.failure : undefined;
  const reason =
    baseFailure === undefined
      ? undefined
      : (atBase.incomplete ??
        (input.failure.placeholder !== undefined || baseFailure.placeholder !== undefined
          ? notVerifiedReason(input.failure, baseFailure)
          : undefined));
  const known = new Set(baseFailure?.keys);
  const keys =
    baseFailure !== undefined && reason === undefined
      ? input.failure.keys.filter((key) => known.has(key))
      : [];
  publishReviewCheck(input.notices, {
    status: 'done',
    id: input.id,
    command: input.command,
    moment: 'base',
    passed: atBase.run.status === 'pass',
    detail: reason,
    ...(atBase.run.reusedAt === undefined
      ? { duration: Date.now() - startedAt }
      : { reusedAt: atBase.run.reusedAt }),
    newFailures: reason === undefined ? input.failure.keys.length - keys.length : 0,
    preExisting: keys.length,
    notVerified: reason === undefined ? undefined : input.failure.keys.length,
    ...(reason === undefined && {
      newKeys: input.failure.keys.filter((key) => !known.has(key)),
      preExistingKeys: keys,
    }),
  });
  return { keys, run: atBase.run, notVerified: reason };
}

function noRunBase(
  notices: { bus: EventBus; phase: WorkflowState['phase'] },
  chosen: { id: string; command: string },
): { keys: string[]; unavailable: string } {
  const detail = 'this run recorded no run base';
  publishReviewCheck(notices, {
    status: 'not-run',
    id: chosen.id,
    command: chosen.command,
    moment: 'base',
    detail,
  });
  return { keys: [], unavailable: `not run: ${detail}` };
}

/**
 * The failures of a red reviewer check split by the run base: `preExisting` are the keys the same
 * command text also shows there. `notVerified` says why a red that is also red at the run base is
 * not shown to be the same failure; its keys stay new.
 */
async function splitAtRunBase(input: {
  run: Extract<CheckRunResult, { status: 'fail' }>;
  command: string;
  checkOptions: RunChecksOptions;
}): Promise<{
  preExisting: string[];
  base?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const { run, command, checkOptions } = input;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const failure = run.failure;
  const atBase =
    checkOptions.base === undefined
      ? noRunBase(notices, { id: run.checkId, command })
      : await preExistingKeys({
          id: run.checkId,
          command,
          failure,
          base: checkOptions.base,
          checkOptions,
          notices,
        });
  return {
    preExisting: atBase.keys,
    base: 'run' in atBase ? atBase.run : undefined,
    unavailable: atBase.unavailable,
    notVerified: 'notVerified' in atBase ? atBase.notVerified : undefined,
  };
}

/** Runs a reviewer check once; only a pre-review red splits at the run base. */
export async function runReviewCheck(
  input: {
    check: { id: string; command: string };
    checkOptions: RunChecksOptions;
  } & ({ moment: 'pre-review' } | { moment: 'brief'; carried: FixCheckKeys | undefined }),
): Promise<{
  run: CheckRunResult;
  fresh: string[];
  unavailable?: string | undefined;
  notVerified?: string | undefined;
}> {
  const { moment, checkOptions } = input;
  const { id, command } = input.check;
  const notices = { bus: checkOptions.bus, phase: checkOptions.phase };
  const startedAt = Date.now();
  const [result] = await runChecks([id], checkOptions, (_check, prepared) =>
    publishReviewCheck(notices, { status: 'running', id, command: prepared, moment }),
  );
  const run: CheckRunResult = result ?? {
    checkId: id,
    status: 'unknown',
    output: `no result for ${id}`,
  };
  if (run.status !== 'pass' && run.status !== 'fail') {
    publishReviewCheck(notices, {
      status: run.status === 'refused' ? 'refused' : 'not-run',
      id,
      command,
      moment,
      detail: run.output,
    });
    return { run, fresh: [] };
  }
  const judged =
    input.moment === 'brief' && (run.status === 'fail' || run.status === 'pass')
      ? judgeFixCheck(input.carried, run.status === 'fail' ? run.failure : null)
      : null;
  publishReviewCheck(notices, {
    status: 'done',
    id,
    command: run.command ?? command,
    moment,
    passed: run.status === 'pass' || judged?.left.length === 0,
    ...(run.reusedAt === undefined
      ? { duration: Date.now() - startedAt }
      : { reusedAt: run.reusedAt }),
    ...(judged !== null && fixCheckCounts(judged)),
  });
  if (run.status !== 'fail') return { run, fresh: [] };
  if (moment === 'brief') return { run, fresh: judged === null ? run.failure.keys : judged.left };
  const { preExisting, base, unavailable, notVerified } = await splitAtRunBase({
    run,
    command,
    checkOptions,
  });
  const split: CheckRunResult = {
    ...run,
    ...(preExisting.length > 0 && { preExisting }),
    ...(base !== undefined && {
      base: {
        output: base.output,
        ...(base.exitCode !== undefined && { exitCode: base.exitCode }),
      },
    }),
  };
  return { run: split, fresh: newFailureKeys(split), unavailable, notVerified };
}

/** A repeated review re-runs its commands: their earlier inputs give way to this run's. */
function replaceReviewCheckInputs(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
  inputs: readonly TriageInput[],
): WorkflowState {
  const pending = state.pendingTriage;
  const kept = (pending?.inputs ?? []).filter((input) => !REVIEW_CHECK_INPUT_ID.test(input.id));
  if (inputs.length === 0 && kept.length === (pending?.inputs.length ?? 0)) return state;
  return transitionAndSave(ref, state, {
    type: 'QUEUE_TRIAGE',
    inputs: [...kept, ...inputs],
    ...(pending?.question !== undefined && { question: pending.question }),
  });
}

/**
 * SPLITBRIEF runs the project gate the plan names in the run workspace under the reviewer command
 * policy, re-runs a red command at the run base with the same text, and stops at the first command
 * with new failures. New failures become pending inputs; the returned section tells the verdict
 * call what ran, what did not, and why.
 */
export async function runReviewChecks(opts: ReviewChecksOptions): Promise<ReviewChecksOutcome> {
  let state = opts.state;
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const notices = { bus: opts.bus, phase: state.phase };
  if (!resolveEndChecks(opts.config)) {
    publishReviewChecks(notices, 'off');
    return { state, section: OFF_SECTION, preExistingChecks: [] };
  }
  const gate = enabledReviewChecks(opts.config, state.plan);
  if (gate.length === 0) {
    publishReviewChecks(notices, 'none');
    return { state, section: NO_GATE_SECTION, preExistingChecks: [] };
  }

  const base = runBaseOf(ref, state);
  const checkOptions: RunChecksOptions = {
    plan: state.plan,
    tasks: state.tasks,
    reviewChecks: gate,
    base,
    projectDir: opts.workspaceDir,
    sessionId: opts.sessionId,
    checkoutDir: opts.projectDir,
    config: opts.config,
    bus: opts.bus,
    phase: state.phase,
    npmScriptsApproved: planApprovesNpmScripts({ config: opts.config, state }),
    discoveredValidation: state.discoveredValidation,
    signal: opts.signal,
    results: { ref, state, tree: 'workspace' },
  };
  const ledger = readEvidenceLedger(ref);
  const runs: CheckRunResult[] = [];
  const inputs: TriageInput[] = [];
  const lines: string[] = [];
  const preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']> = [];
  let stoppedBy: string | undefined;
  for (const check of gate) {
    const chosen = { id: check.id, command: check.value };
    const label = `${chosen.id} \`${chosen.command}\``;
    if (stoppedBy !== undefined) {
      publishReviewCheck(notices, {
        status: 'not-run',
        id: chosen.id,
        command: chosen.command,
        moment: 'pre-review',
        detail: `${stoppedBy} failed`,
      });
      lines.push(`- ${label}: not run, ${stoppedBy} failed`);
      continue;
    }
    const { run, fresh, unavailable, notVerified } = await runReviewCheck({
      check: chosen,
      moment: 'pre-review',
      checkOptions,
    });
    runs.push(run);
    if (run.status !== 'pass' && run.status !== 'fail') {
      lines.push(`- ${label}: ${run.status === 'refused' ? 'refused' : 'not run'}, ${run.output}`);
      continue;
    }
    if (run.status !== 'fail') {
      lines.push(`- ${label}: passed`);
      continue;
    }
    const preExisting = run.preExisting ?? [];
    if (preExisting.length > 0) {
      preExistingChecks.push({ id: chosen.id, command: chosen.command, keys: [...preExisting] });
    }
    lines.push(
      notVerified === undefined
        ? `- ${label}: failed, ${fresh.length} new failure(s)${
            preExisting.length > 0
              ? `; ${preExisting.length} pre-existing (also red at the run base)`
              : ''
          }${unavailable === undefined ? '' : `; base re-run ${unavailable}`}`
        : `- ${label}: failed, not verified at the run base (${notVerified}); the reviewer decides`,
      checkFailureText(run),
    );
    if (fresh.length === 0) continue;
    stoppedBy = chosen.id;
    const named = failingFilesFromKeys(fresh, opts.workspaceDir);
    for (const file of named.length > 0 ? named : [null]) {
      const owner = fileOwnerSentence(ledger, state.tasks, file);
      const failureKeys = failureKeysForFile({ failure: { ...run.failure, keys: fresh }, file });
      inputs.push({
        id: `${chosen.id}.${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `Reviewer check ${chosen.id} (${chosen.command}) failed ${
          notVerified === undefined
            ? 'with new failures.'
            : run.base === undefined
              ? `and SPLITBRIEF could not verify its run base re-run (${notVerified}); the reviewer decides.`
              : `and failed at the run base too, but SPLITBRIEF could not verify it is the same failure (${notVerified}); the reviewer decides.`
        }${owner === undefined ? '' : ` ${owner}`}\n${checkFailureText(run, { file })}`,
        checkIds: [chosen.id],
        command: chosen.command,
        output: run.output,
        ...(failureKeys.length > 0 && { failureKeys }),
        ...(run.status === 'fail' && { redKeys: run.failure.keys }),
      });
    }
  }

  if (runs.length > 0) {
    await recordCheckRuns({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      state,
      task: state.tasks.at(-1),
      runs,
    });
  }
  state = replaceReviewCheckInputs(ref, state, inputs);
  const section = [
    '## Reviewer checks',
    '',
    'Before this review SPLITBRIEF ran the project gate the plan names, in the run workspace; their output is in the Checks Log. A failure marked pre-existing also fails at the run base: raise no finding for it. A failure marked not verified at the run base is red at the run base too, but SPLITBRIEF could not show it is the same failure, or SPLITBRIEF could not re-run it there: decide from the output. Each new or not verified failure is a pending input.',
    '',
    ...lines,
  ].join('\n');
  return { state, section, preExistingChecks };
}
