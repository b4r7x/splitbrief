import { z } from 'zod';
import type { RecoveryFact } from '../../core/schemas/recovery/schemas.js';
import { type AppError, error } from '../../utils/error.js';
import { isRecord, typedEntries } from '../../utils/type-guards.js';

/** A measurement that was actually taken; an absent one is omitted, never zero. */
const TokenCount = z.number().int().nonnegative().optional();
const BudgetSource = z.enum(['configured', 'observed-active', 'application-default']);
const OmittedRequestOption = z.enum([
  'temperature',
  'reasoning_effort',
  'stream_options.include_usage',
]);
export type ApiContextOmittedRequestOption = z.infer<typeof OmittedRequestOption>;

export const ApiContextDiagnosticSchema = z
  .object({
    code: z.literal('insufficient-context'),
    seat: z.enum(['plan', 'review']),
    cause: z.enum(['missing-required', 'unsupported-required', 'input-budget', 'output-budget']),
    missingSections: z.array(z.string()),
    model: z.string().optional(),
    inputEstimate: TokenCount,
    estimationMargin: TokenCount,
    requiredOutputTokens: TokenCount,
    requiredTokens: TokenCount,
    availableTokens: TokenCount,
    outputCap: TokenCount,
    /** The producer's actual application limit source; absent means legacy/unknown. */
    budgetSource: BudgetSource.optional(),
    /** Wire options the resolved provider policy omitted; absent means legacy/unknown. */
    omittedRequestOptions: z.array(OmittedRequestOption).optional(),
  })
  .strict();

export type ApiContextDiagnostic = z.infer<typeof ApiContextDiagnosticSchema>;

export const API_INSUFFICIENT_CONTEXT = 'api-insufficient-context';

export type ApiContextError = AppError<
  typeof API_INSUFFICIENT_CONTEXT,
  { diagnostic: ApiContextDiagnostic }
>;

const SEAT_NOUN: Readonly<Record<ApiContextDiagnostic['seat'], string>> = {
  plan: 'planning',
  review: 'review',
};

const CAUSE_SENTENCE: Readonly<Record<ApiContextDiagnostic['cause'], string>> = {
  'missing-required': 'Evidence this call requires is missing.',
  'unsupported-required': 'Required material is not readable as text.',
  'input-budget': 'The required material does not fit the seat’s context window.',
  'output-budget': 'The seat cannot reserve enough room for its own answer.',
};

/**
 * Qualitative only: the summary names the cause and the sections, never a token
 * estimate. The figures ride in `data.diagnostic` for the details view.
 */
function summarize(diagnostic: ApiContextDiagnostic): string {
  const sections =
    diagnostic.missingSections.length > 0
      ? ` Missing: ${diagnostic.missingSections.join(', ')}.`
      : '';
  return `The ${SEAT_NOUN[diagnostic.seat]} seat was not given the context this call needs, so nothing was dispatched. ${CAUSE_SENTENCE[diagnostic.cause]}${sections}`;
}

/** The one error every insufficient PLAN or REVIEW packet is raised as. */
export function apiContextError(diagnostic: ApiContextDiagnostic): ApiContextError {
  return error(API_INSUFFICIENT_CONTEXT, summarize(diagnostic), { diagnostic });
}

/**
 * Reads the diagnosis back off a thrown value by validating its data, never by
 * matching its message. Accepts the error, its `data`, or a bare diagnostic.
 */
export function readApiContextDiagnostic(value: unknown): ApiContextDiagnostic | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : undefined;
  for (const candidate of [value, value.diagnostic, data, data?.diagnostic]) {
    const parsed = ApiContextDiagnosticSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * The only spelling of the diagnosis as `RecoveryIssue.facts` primitives. Every
 * missing section survives here whatever the details string truncates, and a
 * measurement nobody took is absent rather than zero. Carries no credential and
 * no context content.
 */
const MEASUREMENT_FACT_KEYS = {
  inputEstimate: 'apiContextInputEstimate',
  estimationMargin: 'apiContextEstimationMargin',
  requiredOutputTokens: 'apiContextRequiredOutputTokens',
  requiredTokens: 'apiContextRequiredTokens',
  availableTokens: 'apiContextAvailableTokens',
  outputCap: 'apiContextOutputCap',
} as const;

const DIAGNOSTIC_FACT_KEYS = {
  budgetSource: 'apiContextBudgetSource',
  omittedRequestOptions: 'apiContextOmittedRequestOptionsJson',
} as const;

export function apiContextRecoveryFacts(
  diagnostic: ApiContextDiagnostic,
): Record<string, RecoveryFact> {
  const facts: Record<string, RecoveryFact> = {
    apiContextCode: diagnostic.code,
    apiContextSeat: diagnostic.seat,
    apiContextCause: diagnostic.cause,
    apiContextMissingSectionsJson: JSON.stringify(diagnostic.missingSections),
    ...(diagnostic.model !== undefined && { apiContextModel: diagnostic.model }),
  };
  for (const [field, key] of typedEntries(MEASUREMENT_FACT_KEYS)) {
    const measured = diagnostic[field];
    if (measured !== undefined) facts[key] = measured;
  }
  if (diagnostic.budgetSource !== undefined) {
    facts[DIAGNOSTIC_FACT_KEYS.budgetSource] = diagnostic.budgetSource;
  }
  if (diagnostic.omittedRequestOptions !== undefined) {
    facts[DIAGNOSTIC_FACT_KEYS.omittedRequestOptions] = JSON.stringify(
      diagnostic.omittedRequestOptions,
    );
  }
  return facts;
}
