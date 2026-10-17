import type { DeepReadonly, RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { stripRecoveryResetClause } from '../../../core/recovery/reset-clock.js';
import {
  runnerOwnWords,
  typedRunnerCallErrorCode,
  typedRunnerCallErrorMessage,
} from '../../implementers/pipeline/call-result.js';
import { runnerAuthDisplayName, runnerLoginInstruction } from '../../runners/auth-failure.js';
import { classifySeatFailure } from '../../runners/seat-failure.js';
import type { SeatFailureClassification } from '../../runners/seat-failure.js';
import { usageLimitAdvice } from '../../runners/usage-limit.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { labelError } from '../../../utils/format-errors.js';
import { isRecord } from '../../../utils/type-guards.js';
import { nowIso } from '../../../utils/format-time.js';
import { runnerDefectRow, runnerHaltRow, toolReported } from './builders/task.js';
import {
  buildPlannerCallFailedRecoveryIssue,
  type PlannerCallFailureRecoveryOptions,
  type PlannerSeatFailure,
} from './builders/planner.js';
import { loadSeatSwapContext } from './seat-swap-context.js';

/**
 * What the classifier read from a seat-down failure: the classification and the
 * tool's own words, which the one seat-down halt builder consumes.
 */
type PlannerSeatDownDiagnosis = Readonly<{
  classification: SeatFailureClassification;
  requestId?: string | undefined;
}>;

/**
 * What a failed planner-tier call — a planning step, a brief's hint, the final review — says
 * about the seat it ran on: out of quota, signed out, or neither.
 */
export type PlannerCallDiagnosis = Readonly<{
  failure: PlannerSeatFailure;
  /** The label, the tool's own words, and what to do about a limit or a sign-out. */
  message: string;
  /** The runner as a halt names it. */
  tool: string;
  /** The tool's own words as the panel quotes them; empty when the call carried none. */
  details: string[];
  /** The tool's own words as a halt reads them, else the message. */
  words: string;
  /** When the quota comes back, when the tool's words named it. */
  resetsAt: Date | null;
  /** Present when the failure is a seat-down cause: what the one halt builder consumes. */
  seatDown?: PlannerSeatDownDiagnosis | undefined;
}>;

/** The tool's own words usually end their sentence already; a second full stop is noise. */
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function diagnosePlannerCallFailure(
  input: Readonly<{
    err: unknown;
    label: string;
    runner: DeepReadonly<RunnerConfig>;
    /** The seat a swap would move, as the advice names it. */
    seat: 'plan' | 'review';
  }>,
): PlannerCallDiagnosis {
  const { err, runner } = input;
  // A failed call keeps the tool's own diagnosis in typed error data. Those words
  // say why it failed, so they follow the label in place of the call's own
  // "Planner review call failed", which says "failed" twice and hides an expired
  // login entirely.
  const typed = typedRunnerCallErrorMessage(err);
  const message =
    typed === null
      ? labelError(input.label, err)
      : `${input.label}: ${sanitizeTerminalDiagnosticText(typed)}`;
  // An API error's own message is a rewritten hint with advice of its own, so a
  // halt that gives its advice starts from the provider's words under the hint.
  const words = runnerOwnWords(err);
  const advised =
    words === null ? message : `${input.label}: ${sanitizeTerminalDiagnosticText(words)}`;
  const tool = runnerAuthDisplayName(runner);
  const details = typed === null ? [] : [toolReported(tool, typed)];
  const said = typed ?? words ?? message;
  // A model the tool refused is the tool's own verdict on the seat's model: no
  // reading of the words turns it into a quota or a sign-in, and the halt asks
  // the route's credential listing which of the two it is.
  if (typedRunnerCallErrorCode(err) === 'missing-model') {
    return { failure: 'missing-model', message, tool, details, words: said, resetsAt: null };
  }
  // The one classifier reads the tool's own words. A limit outranks the auth
  // check: its message must never earn login advice, because logging in does
  // not restore quota. API planners throw their provider errors, so the status
  // is read from the typed data.
  const data = isRecord(err) && isRecord(err.data) ? err.data : undefined;
  const rawStatus = data?.status ?? data?.statusCode;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const classification = classifySeatFailure({
    message: words ?? typed ?? message,
    ...(status !== undefined && { status }),
    source: 'thrown',
  });
  if (
    classification.class === 'rate-limited' ||
    (classification.class === 'account' && classification.cause !== 'auth')
  ) {
    const resetsAt = classification.class === 'rate-limited' ? classification.resetAt : null;
    // The row spells the reset from `resetsAt`, so the tool's words that end the message drop theirs.
    const advice = resetsAt === null ? advised : stripRecoveryResetClause(advised);
    return {
      failure: 'usage-limit',
      message: `${endSentence(advice)} ${usageLimitAdvice({ tool, seat: input.seat })}`,
      tool,
      details,
      words: said,
      resetsAt,
      seatDown: { classification },
    };
  }
  if (classification.class === 'account') {
    return {
      failure: 'unauthenticated',
      message: `${endSentence(advised)} ${runnerLoginInstruction(runner)}`,
      tool,
      details,
      words: said,
      resetsAt: null,
      seatDown: { classification },
    };
  }
  return { failure: 'call-failed', message, tool, details, words: said, resetsAt: null };
}

/**
 * The error row a planner-tier halt publishes. A failed call is its own message;
 * a model refusal reads as the runner defect it is; every seat-down halt adds the
 * tool's own words.
 */
export function plannerHaltRow(issue: RecoveryIssue, diagnosis: PlannerCallDiagnosis): string {
  switch (diagnosis.failure) {
    case 'call-failed':
      return diagnosis.message;
    case 'missing-model':
      return runnerDefectRow(issue, diagnosis.tool, diagnosis.words);
    case 'unauthenticated':
    case 'usage-limit':
      return runnerHaltRow(issue, diagnosis.tool, diagnosis.words);
  }
}

/**
 * The halt a failed planner-tier call raises: on the seat the call ran on, offering
 * the tools the last readiness pass saw ready for the seat a swap moves.
 */
export async function plannerCallHaltIssue(
  input: Omit<PlannerCallFailureRecoveryOptions, 'id' | 'seatSwap' | 'createdAt' | 'runner'> &
    Readonly<{
      projectDir: string;
      config: Config;
      modelCache: ModelCacheAccessor | undefined;
      /** The seat a swap moves, and the runner it runs now. */
      swap: Omit<Parameters<typeof loadSeatSwapContext>[0], 'projectDir' | 'config' | 'modelCache'>;
    }>,
): Promise<RecoveryIssue> {
  const { projectDir, config, modelCache, swap, ...halt } = input;
  const seatSwap = await loadSeatSwapContext({
    projectDir,
    config,
    modelCache,
    ...swap,
    refusal: halt.diagnosis.words,
  });
  return buildPlannerCallFailedRecoveryIssue({
    ...halt,
    runner: swap.runner,
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
}
