import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { recoveryFactString, recoveryFactNumber } from '../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';

export const USAGE_COUNTERS = ['input', 'output', 'cacheRead', 'cacheCreate', 'reasoning'] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];

export type UsageSeat = 'plan' | 'build' | 'review';

/** The two seats a packet is assembled for; BUILD gets its context from the brief, not a packet. */
type RecoveryContextSeat = Extract<UsageSeat, 'plan' | 'review'>;

const RECOVERY_CONTEXT_CAUSES = [
  'missing-required',
  'unsupported-required',
  'input-budget',
  'output-budget',
] as const;
type RecoveryContextCause = (typeof RECOVERY_CONTEXT_CAUSES)[number];
const RECOVERY_CONTEXT_BUDGET_SOURCES = [
  'configured',
  'observed-active',
  'application-default',
] as const;
export type RecoveryContextBudgetSource = (typeof RECOVERY_CONTEXT_BUDGET_SOURCES)[number];
const RECOVERY_CONTEXT_OMITTED_OPTIONS = [
  'temperature',
  'reasoning_effort',
  'stream_options.include_usage',
] as const;
export type RecoveryContextOmittedOption = (typeof RECOVERY_CONTEXT_OMITTED_OPTIONS)[number];

/**
 * The halt's own diagnosis, read back from the facts the engine persisted
 * (`apiContextRecoveryFacts`). Every field is what was recorded: a measurement nobody took and a
 * list a legacy record never wrote are `null` here, never a zero and never an empty list.
 */
export interface RecoveryContextDetails {
  seat: RecoveryContextSeat;
  cause: RecoveryContextCause | null;
  model: string | null;
  missingSections: readonly string[] | null;
  inputEstimate: number | null;
  estimationMargin: number | null;
  requiredOutputTokens: number | null;
  requiredTokens: number | null;
  availableTokens: number | null;
  outputCap: number | null;
  budgetSource: RecoveryContextBudgetSource | null;
  omittedRequestOptions: readonly RecoveryContextOmittedOption[] | null;
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

// The lossless list the details string truncates. A record that never wrote it, or wrote something
// this cannot read, is unknown — not a run that was missing nothing.
function contextMissingSections(issue: RecoveryIssue): readonly string[] | null {
  const raw = recoveryFactString(issue.facts, 'apiContextMissingSectionsJson');
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function contextNumber(issue: RecoveryIssue, key: string): number | null {
  return recoveryFactNumber(issue.facts, key) ?? null;
}

function contextBudgetSource(issue: RecoveryIssue): RecoveryContextBudgetSource | null {
  const source = recoveryFactString(issue.facts, 'apiContextBudgetSource');
  return RECOVERY_CONTEXT_BUDGET_SOURCES.find((candidate) => candidate === source) ?? null;
}

function contextOmittedRequestOptions(
  issue: RecoveryIssue,
): readonly RecoveryContextOmittedOption[] | null {
  const raw = recoveryFactString(issue.facts, 'apiContextOmittedRequestOptionsJson');
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const options: RecoveryContextOmittedOption[] = [];
    for (const entry of parsed) {
      const option = RECOVERY_CONTEXT_OMITTED_OPTIONS.find((candidate) => candidate === entry);
      if (option === undefined) return null;
      options.push(option);
    }
    return options;
  } catch {
    return null;
  }
}

/**
 * The context diagnosis a halt carries, or `null` when the halt is about something else. Only the
 * `apiContext*` facts are read: the prose the panel renders is the panel's, and the figures are
 * this surface's.
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
    model: recoveryFactString(issue.facts, 'apiContextModel') ?? null,
    missingSections: contextMissingSections(issue),
    inputEstimate: contextNumber(issue, 'apiContextInputEstimate'),
    estimationMargin: contextNumber(issue, 'apiContextEstimationMargin'),
    requiredOutputTokens: contextNumber(issue, 'apiContextRequiredOutputTokens'),
    requiredTokens: contextNumber(issue, 'apiContextRequiredTokens'),
    availableTokens: contextNumber(issue, 'apiContextAvailableTokens'),
    outputCap: contextNumber(issue, 'apiContextOutputCap'),
    budgetSource: contextBudgetSource(issue),
    omittedRequestOptions: contextOmittedRequestOptions(issue),
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
