import type { DeepReadonly, RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { stripRecoveryResetClause } from '../../../core/recovery/reset-clock.js';
import {
  runnerOwnWords,
  typedRunnerCallErrorMessage,
} from '../../implementers/pipeline/call-result.js';
import {
  isAuthFailureDiagnostic,
  runnerAuthDisplayName,
  runnerLoginInstruction,
} from '../../runners/auth-failure.js';
import {
  isUsageLimitDiagnostic,
  parseUsageLimitReset,
  usageLimitAdvice,
  usageLimitDetailFromError,
} from '../../runners/usage-limit.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { labelError } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  buildPlannerCallFailedRecoveryIssue,
  type PlannerCallFailureRecoveryOptions,
  type PlannerSeatFailure,
} from './builders/planner.js';
import { loadSeatSwapContext } from './seat-swap-context.js';

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
  /** When the quota comes back, when the tool's words named it. */
  resetsAt: Date | null;
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
  const details = typed === null ? [] : [`${tool} reported: ${typed}`];
  // A limit outranks the auth check: its message must never earn login
  // advice, because logging in does not restore quota. API planners throw
  // their provider errors, so the raw 429 detail is read from typed data.
  const limitDetail =
    usageLimitDetailFromError(err) ??
    (isUsageLimitDiagnostic(typed ?? message) ? (typed ?? message) : null);
  if (limitDetail !== null) {
    const resetsAt = parseUsageLimitReset(limitDetail);
    // The row spells the reset from `resetsAt`, so the tool's words that end the message drop theirs.
    const said = resetsAt === null ? advised : stripRecoveryResetClause(advised);
    return {
      failure: 'usage-limit',
      message: `${endSentence(said)} ${usageLimitAdvice({ tool, seat: input.seat })}`,
      tool,
      details,
      resetsAt,
    };
  }
  if (isAuthFailureDiagnostic(typed ?? message)) {
    return {
      failure: 'unauthenticated',
      message: `${endSentence(advised)} ${runnerLoginInstruction(runner)}`,
      tool,
      details,
      resetsAt: null,
    };
  }
  return { failure: 'call-failed', message, tool, details, resetsAt: null };
}

/**
 * The halt a failed planner-tier call raises: on the seat the call ran on, offering
 * the tools the last readiness pass saw ready for the seat a swap moves.
 */
export async function plannerCallHaltIssue(
  input: Omit<PlannerCallFailureRecoveryOptions, 'id' | 'seatSwap' | 'createdAt'> &
    Readonly<{
      projectDir: string;
      /** The seat a swap moves, and the runner it runs now. */
      swap: Omit<Parameters<typeof loadSeatSwapContext>[0], 'projectDir'>;
    }>,
): Promise<RecoveryIssue> {
  const { projectDir, swap, ...halt } = input;
  const seatSwap = await loadSeatSwapContext({ projectDir, ...swap });
  return buildPlannerCallFailedRecoveryIssue({
    ...halt,
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
}
