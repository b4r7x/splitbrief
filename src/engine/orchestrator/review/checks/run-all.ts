import { checkFailureSummary } from '../../../../core/review/fix/checks.js';
import { resolveEndChecks } from '../../../../core/config/runtime/resolve.js';
import { readEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { TriageInput } from '../../../../core/schemas/review/verdict.js';
import type { ReviewRecord } from '../../../../core/schemas/workflow/review-record.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../../events/types.js';
import { publishReviewChecks, publishReviewCheck } from '../../publish/review.js';
import { recordCheckRuns } from '../../evidence/record-checks.js';
import { runBaseOf } from '../../isolation/run-base/tree.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { failingFilesFromKeys, fileOwnerSentence } from '../../task/file-owner.js';
import { withAttemptRestoreScope } from '../../task/restore-scope.js';
import type { BaseGate } from '../../validation/base-gate.js';
import { checkFailureText, failureKeysForFile } from '../../validation/failure-text.js';
import { enabledReviewChecks, planApprovesNpmScripts } from '../../validation/checks/runner.js';
import type { RunChecksOptions, CheckRunResult } from '../../validation/checks/types.js';
import { runReviewCheck } from './run-one.js';

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
    const { run, fresh, unavailable, notVerified } = await withAttemptRestoreScope({
      ref,
      dir: opts.workspaceDir,
      taskStartSnapshot: null,
      run: () =>
        runReviewCheck({
          check: chosen,
          moment: 'pre-review',
          baseGate: opts.baseGate,
          checkOptions,
        }),
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
        text: [
          checkFailureSummary(chosen.command, failureKeys.length || fresh.length),
          ...(notVerified === undefined
            ? []
            : [`Could not verify the failure at the run base (${notVerified}).`]),
          ...(owner === undefined ? [] : [owner]),
        ].join(' '),
        checkIds: [chosen.id],
        command: chosen.command,
        output: run.output,
        checkDetail: checkFailureText(run, { file }),
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
