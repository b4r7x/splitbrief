import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { recoveryFactString, recoveryFactNumber } from '../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';

type RecoveryContextSeat = 'plan' | 'review';

const RECOVERY_CONTEXT_CAUSES = [
  'missing-required',
  'unsupported-required',
  'input-budget',
  'output-budget',
] as const;
type RecoveryContextCause = (typeof RECOVERY_CONTEXT_CAUSES)[number];
export interface RecoveryContextDetails {
  seat: RecoveryContextSeat;
  cause: RecoveryContextCause | null;
  requiredTokens: number | null;
  availableTokens: number | null;
}

/** The words the panel and this surface both use for a cause; one halt, one spelling. */
const RECOVERY_CONTEXT_CAUSE_WORDS: Readonly<Record<RecoveryContextCause, string>> = {
  'missing-required': 'required evidence was missing',
  'unsupported-required': 'required material is not text',
  'input-budget': 'larger than the context window',
  'output-budget': 'no room left for the answer',
};

function contextSeat(issue: RecoveryIssue): RecoveryContextSeat | null {
  const seat = issue.seat ?? recoveryFactString(issue.facts, 'apiContextSeat');
  return seat === 'plan' || seat === 'review' ? seat : null;
}

function contextCause(issue: RecoveryIssue): RecoveryContextCause | null {
  const cause = recoveryFactString(issue.facts, 'apiContextCause');
  return RECOVERY_CONTEXT_CAUSES.find((candidate) => candidate === cause) ?? null;
}

function contextNumber(issue: RecoveryIssue, key: string): number | null {
  return recoveryFactNumber(issue.facts, key) ?? null;
}

/**
 * The context diagnosis a halt carries, or `null` when the halt is about something else. Only the
 * `apiContext*` fields are read.
 */
export function readRecoveryContext(
  issue: RecoveryIssue | null | undefined,
): RecoveryContextDetails | null {
  if (issue === null || issue === undefined) return null;
  if (recoveryFactString(issue.facts, 'apiContextCode') !== 'insufficient-context') return null;
  const seat = contextSeat(issue);
  if (seat === null) return null;
  return {
    seat,
    cause: contextCause(issue),
    requiredTokens: contextNumber(issue, 'apiContextRequiredTokens'),
    availableTokens: contextNumber(issue, 'apiContextAvailableTokens'),
  };
}

/** How the halt reads in one line, wherever a surface states the cause. */
export function recoveryContextCauseWords(context: RecoveryContextDetails): string {
  return context.cause === null
    ? 'the reason was not recorded'
    : RECOVERY_CONTEXT_CAUSE_WORDS[context.cause];
}

export function recoveryContextSeatLabel(context: RecoveryContextDetails): string {
  return CREW_SEAT_LABELS[context.seat];
}
