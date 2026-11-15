import { type ReviewScope, findingInReviewScope } from '../../../core/review/scope.js';
import { verificationKey } from '../../../core/review/verdict.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { ReviewVerdict, TriageInput } from '../../../core/schemas/review/verdict.js';
import type { ReviewRecord } from '../../../core/schemas/workflow/review-record.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../events/types.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { runBaseOf } from '../isolation/run-base/tree.js';
import { runCheckWithRows } from './checks/rows.js';
import { newFailureKeys, checkFailureText } from '../validation/failure-text.js';
import { createCheckRunner } from '../validation/checks/runner.js';
import {
  checkRegistry,
  enabledReviewChecks,
  planApprovesNpmScripts,
} from '../validation/checks/runner.js';
import type { CheckRunResult, RunChecksOptions } from '../validation/checks/types.js';
import { forceUnverifiedRenderCriteria } from './renders.js';
import type { TriageContext } from './types.js';

type ReviewVerification = {
  entries: ReviewRecord['verification'];
  map: Map<string, 'pass' | 'fail' | 'unverified'>;
};

function criterionCheckIds(plan: Plan | undefined, criterionId: string | null): readonly string[] {
  return plan?.criteria.find((criterion) => criterion.id === criterionId)?.checkIds ?? [];
}

/**
 * The checks of every unverified criterion and finding, read from the stored results of this tree
 * and run through the same runner briefs use only when none is stored. The claims are collected
 * first, so a check that two claims name runs once. Each claim then reads its status and output
 * from its own checks. A pass needs every named check to pass or to fail only on what
 * `preExistingChecks` saw red at the run base; any other failure is a failure; anything not
 * runnable stays unverified and cannot verify a claim.
 */
export async function verifyReviewClaims(args: {
  verdict: ReviewVerdict;
  scope: ReviewScope;
  state: WorkflowState;
  redInputs: readonly TriageInput[];
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>;
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  bus: EventBus;
  signal?: AbortSignal | undefined;
}): Promise<ReviewVerification> {
  const entries: ReviewRecord['verification'] = [];
  const map = new Map<string, 'pass' | 'fail' | 'unverified'>();
  if (args.redInputs.some((input) => input.source === 'check')) {
    return { entries, map };
  }
  const claims: { key: string; checkIds: readonly string[] }[] = [];
  const collect = (
    kind: 'criterion' | 'finding',
    id: string,
    checkIds: readonly string[],
  ): void => {
    if (checkIds.length === 0) return;
    claims.push({ key: verificationKey(kind, id), checkIds });
  };
  for (const criterion of args.verdict.criteria) {
    if (criterion.status !== 'unverified') continue;
    collect('criterion', criterion.id, criterionCheckIds(args.state.plan, criterion.id));
  }
  for (const finding of args.verdict.findings) {
    if (!findingInReviewScope(finding, args.scope)) continue;
    if (finding.kind !== 'unverified') continue;
    const named = finding.checkIds ?? [];
    collect(
      'finding',
      finding.id,
      named.length > 0 ? named : criterionCheckIds(args.state.plan, finding.criterionId),
    );
  }
  if (claims.length === 0) return { entries, map };
  const runs = await verifyClaimChecks(
    args,
    args.state,
    claims.flatMap((claim) => claim.checkIds),
    args.preExistingChecks,
    undefined,
  );
  for (const claim of claims) {
    const { status, output } = claimVerification(runs, claim.checkIds);
    map.set(claim.key, status);
    entries.push({ id: claim.key, status, output });
  }
  return { entries, map };
}

/**
 * A render check with no attached image can only stay unverified: the reviewer saw no render of
 * it, so nothing it says may turn one into a pass. `unseenRenderCriteria` names the criteria it
 * kept unverified for a seat that takes no images.
 */
export function keepUnseenRendersUnverified(input: {
  verdict: ReviewVerdict;
  verification: ReviewVerification;
  missingCheckIds: readonly string[];
  plan: Plan | undefined;
  seatTakesImages: boolean;
}): {
  verdict: ReviewVerdict;
  verification: ReviewVerification;
  unseenRenderCriteria: readonly string[];
} {
  const { verdict, verification } = input;
  if (input.missingCheckIds.length === 0) {
    return { verdict, verification, unseenRenderCriteria: [] };
  }
  const forced = forceUnverifiedRenderCriteria({
    verdict,
    renderCheckIds: input.missingCheckIds,
    criterionCheckIds: (criterionId) => criterionCheckIds(input.plan, criterionId),
    verification: verification.map,
  });
  const forcedKeys = new Set(
    forced.forcedCriterionIds.map((id) => verificationKey('criterion', id)),
  );
  return {
    verdict: forced.verdict,
    verification: {
      map: verification.map,
      entries: verification.entries.map((entry) =>
        forcedKeys.has(entry.id) ? { ...entry, status: 'unverified' as const } : entry,
      ),
    },
    unseenRenderCriteria: input.seatTakesImages ? [] : forced.forcedCriterionIds,
  };
}

/** A red whose failures were all red at the run base too verifies the claim like a pass. */
function checkVerificationStatus(runs: readonly CheckRunResult[]): 'pass' | 'fail' | 'unverified' {
  if (runs.some((run) => newFailureKeys(run).length > 0)) return 'fail';
  if (runs.length > 0 && runs.every((run) => run.status === 'pass' || run.status === 'fail')) {
    return 'pass';
  }
  return 'unverified';
}

function checkVerificationOutput(runs: readonly CheckRunResult[]): string {
  return runs
    .map((run) => {
      if (run.status === 'fail') return checkFailureText(run);
      const output = run.output.trim();
      return `${run.checkId}: ${run.status}${output === '' ? '' : ` — ${output}`}`;
    })
    .join('\n');
}

/** The status and output of one claim, read only from the runs of the checks it selects. */
export function claimVerification(
  runs: readonly CheckRunResult[],
  checkIds: readonly string[],
): { status: 'pass' | 'fail' | 'unverified'; output: string } {
  const selected = runs.filter((run) => checkIds.includes(run.checkId));
  return { status: checkVerificationStatus(selected), output: checkVerificationOutput(selected) };
}

/**
 * Runs the checks behind the claims of a review once each and records them, taking each stored
 * result of the same command on this tree. `rerunRedBefore` runs a red stored before that time
 * again: the planner re-runs a red it thinks is flaky. A red keeps as pre-existing the failures
 * `preExistingChecks`, this review's run base split, names for the same check. Each caller reads
 * one claim from the runs its own check ids select (`claimVerification`).
 */
export async function verifyClaimChecks(
  ctx: TriageContext,
  state: WorkflowState,
  checkIds: readonly string[],
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  rerunRedBefore: string | undefined,
): Promise<CheckRunResult[]> {
  const checkOptions: RunChecksOptions = {
    plan: state.plan,
    tasks: state.tasks,
    reviewChecks: enabledReviewChecks(ctx.config, state.plan),
    base: runBaseOf({ projectDir: ctx.projectDir, sessionId: ctx.sessionId }, state),
    projectDir: ctx.workspaceDir,
    sessionId: ctx.sessionId,
    checkoutDir: ctx.projectDir,
    config: ctx.config,
    bus: ctx.bus,
    phase: state.phase,
    npmScriptsApproved: planApprovesNpmScripts({ config: ctx.config, state }),
    ...(state.discoveredValidation !== undefined && {
      discoveredValidation: state.discoveredValidation,
    }),
    results: {
      ref: { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
      state,
      tree: 'workspace',
      rerunRedBefore,
    },
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    ...(ctx.runCommand !== undefined && { runCommand: ctx.runCommand }),
  };
  const prepare = createCheckRunner(checkOptions);
  const registry = checkRegistry(checkOptions);
  const notices = { bus: ctx.bus, phase: state.phase };
  const runs: CheckRunResult[] = [];
  for (const checkId of new Set(checkIds)) {
    const check = registry.get(checkId);
    const run: CheckRunResult =
      check === undefined
        ? { checkId, status: 'unknown', output: `no check ${checkId}` }
        : await runCheckWithRows({
            check,
            prepare,
            notices,
            moment: 'verify',
            atBase: preExistingChecks.find((entry) => entry.id === checkId)?.keys,
          });
    runs.push(run);
  }
  await recordCheckRuns({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    state,
    runs,
  });
  return runs;
}
