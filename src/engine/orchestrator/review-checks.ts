import { resolveEndChecks } from '../../core/config/runtime/resolve.js';
import { readEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { fixCheckCounts, judgeFixCheck, type FixCheckKeys } from '../../core/review/fix-task.js';
import type { Config } from '../../core/schemas/config.js';
import type { TriageInput } from '../../core/schemas/review.js';
import type { ReviewRecord, WorkflowState } from '../../core/schemas/workflow.js';
import { throwIfAborted } from '../../utils/abort.js';
import type { EventBus } from '../events/types.js';
import { recordCheckRuns } from './evidence/record-checks.js';
import { publishReviewCheck, publishReviewChecks } from './events.js';
import type { BaseGate } from './base-gate.js';
import { runBaseIncomplete, runBaseOf, type RunBase } from './isolation/base-tree.js';
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
  /** The project gate's run at the run base beside the build; none when the run has no run base. */
  baseGate: BaseGate | undefined;
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

function noRunBase(
  notices: { bus: EventBus; phase: WorkflowState['phase'] },
  chosen: { id: string; command: string },
): { preExisting: string[]; unavailable: string } {
  const detail = 'this run recorded no run base';
  publishReviewCheck(notices, {
    status: 'not-run',
    id: chosen.id,
    command: chosen.command,
    moment: 'base',
    detail,
  });
  return { preExisting: [], unavailable: `not run: ${detail}` };
}

type BaseSplitCounts = {
  newFailures: number;
  preExisting: number;
  notVerified?: number | undefined;
  newKeys?: string[] | undefined;
  preExistingKeys?: string[] | undefined;
  detail?: string | undefined;
};

/**
 * The failures of a red reviewer check split by the project gate's run at the run base, which ran
 * beside the build: this waits for that run, marks the check's running row as waiting on it
 * (`waitsOnBase`), and never runs the command itself. `preExisting` are
 * the keys the same command text also shows there. A red at the run base proves a pre-existing
 * failure only when both runs name their failures: with a placeholder on either side, or a run base
 * copy with no base commit, nothing is pre-existing, and `notVerified` says why. A base run that
 * could not run leaves every key not verified with its reason; a refused or skipped one leaves every
 * key new, and `unavailable` says why. `counts` is the split the reviewer check's row carries.
 */
async function splitAtRunBase(input: {
  id: string;
  command: string;
  failure: FailureKeys;
  gate: BaseGate | undefined;
  base: RunBase | undefined;
  notices: { bus: EventBus; phase: WorkflowState['phase'] };
}): Promise<{
  preExisting: string[];
  base?: CheckRunResult | undefined;
  unavailable?: string | undefined;
  notVerified?: string | undefined;
  counts?: BaseSplitCounts | undefined;
}> {
  const { failure } = input;
  if (input.gate === undefined || input.base === undefined) {
    return noRunBase(input.notices, { id: input.id, command: input.command });
  }
  publishReviewCheck(input.notices, {
    status: 'running',
    id: input.id,
    command: input.command,
    moment: 'pre-review',
    waitsOnBase: true,
  });
  const atBase = await input.gate.outcome(input.id);
  if (atBase.kind === 'unavailable') {
    return {
      preExisting: [],
      notVerified: atBase.reason,
      counts: {
        newFailures: 0,
        preExisting: 0,
        notVerified: failure.keys.length,
        detail: atBase.reason,
      },
    };
  }
  const { run } = atBase;
  if (run.status !== 'pass' && run.status !== 'fail') {
    return {
      preExisting: [],
      base: run,
      unavailable: `${run.status === 'refused' ? 'refused' : 'not run'}: ${run.output}`,
    };
  }
  const baseFailure = run.status === 'fail' ? run.failure : undefined;
  const reason =
    baseFailure === undefined
      ? undefined
      : (runBaseIncomplete(input.base) ??
        (failure.placeholder !== undefined || baseFailure.placeholder !== undefined
          ? notVerifiedReason(failure, baseFailure)
          : undefined));
  const known = new Set(baseFailure?.keys);
  const keys =
    baseFailure !== undefined && reason === undefined
      ? failure.keys.filter((key) => known.has(key))
      : [];
  return {
    preExisting: keys,
    base: run,
    notVerified: reason,
    counts:
      reason === undefined
        ? {
            newFailures: failure.keys.length - keys.length,
            preExisting: keys.length,
            newKeys: failure.keys.filter((key) => !known.has(key)),
            preExistingKeys: keys,
          }
        : { newFailures: 0, preExisting: 0, notVerified: failure.keys.length, detail: reason },
  };
}

/**
 * Runs a reviewer check once. A pre-review red splits at the run base before its row settles, so
 * the row carries the split; while the review waits on the run base its row stays running.
 */
export async function runReviewCheck(
  input: {
    check: { id: string; command: string };
    checkOptions: RunChecksOptions;
  } & (
    | { moment: 'pre-review'; baseGate: BaseGate | undefined }
    | { moment: 'brief'; carried: FixCheckKeys | undefined }
  ),
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
  const clock =
    run.reusedAt === undefined ? { duration: Date.now() - startedAt } : { reusedAt: run.reusedAt };
  const judged =
    input.moment === 'brief'
      ? judgeFixCheck(input.carried, run.status === 'fail' ? run.failure : null)
      : null;
  const split =
    input.moment === 'pre-review' && run.status === 'fail'
      ? await splitAtRunBase({
          id,
          command: run.command ?? command,
          failure: run.failure,
          gate: input.baseGate,
          base: checkOptions.base,
          notices,
        })
      : null;
  throwIfAborted(checkOptions.signal);
  publishReviewCheck(notices, {
    status: 'done',
    id,
    command: run.command ?? command,
    moment,
    passed: run.status === 'pass' || judged?.left.length === 0,
    ...clock,
    ...(judged !== null && fixCheckCounts(judged)),
    ...split?.counts,
  });
  if (run.status !== 'fail') return { run, fresh: [] };
  if (split === null) return { run, fresh: judged === null ? run.failure.keys : judged.left };
  const { preExisting, base, unavailable, notVerified } = split;
  const splitRun: CheckRunResult = {
    ...run,
    ...(preExisting.length > 0 && { preExisting }),
    ...(base !== undefined && {
      base: {
        output: base.output,
        ...(base.exitCode !== undefined && { exitCode: base.exitCode }),
      },
    }),
  };
  return { run: splitRun, fresh: newFailureKeys(splitRun), unavailable, notVerified };
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
 * policy, compares a red command with the same command's run at the run base, and stops at the
 * first command with new failures. New failures become pending inputs; the returned section tells the verdict
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
      baseGate: opts.baseGate,
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
