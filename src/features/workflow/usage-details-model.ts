import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { formatCost } from '../../core/formatting.js';
import type {
  RunnerCallCounterCoverage,
  RunnerCallCounterCoverageState,
} from '../../core/runner-call-contract.js';
import { billingWord, type RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { recoveryFactNumber, recoveryFactString } from '../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import {
  costAmountBasis,
  costKnownFlags,
  unmeteredRunCostLabel,
  type BillingAttribution,
  type CostAmountBasis,
  type CostBreakdown,
  type RateSnapshot,
  type RequestEstimate,
  type RequestEstimateReason,
} from '../../core/schemas/summary.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import { SOFT_SEP } from '../../core/separators.js';
import { uniqueInOrder } from '../../utils/collections.js';

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
type RecoveryContextBudgetSource = (typeof RECOVERY_CONTEXT_BUDGET_SOURCES)[number];
const RECOVERY_CONTEXT_OMITTED_OPTIONS = [
  'temperature',
  'reasoning_effort',
  'stream_options.include_usage',
] as const;
type RecoveryContextOmittedOption = (typeof RECOVERY_CONTEXT_OMITTED_OPTIONS)[number];

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

/**
 * What the record says about one counter. `reported` carries what the providers sent, zero
 * included; `partial` carries the reported part and names the seats that sent nothing, which never
 * become a zero in the sum.
 */
export type UsageAmount =
  | Readonly<{ kind: 'reported'; tokens: number }>
  | Readonly<{ kind: 'partial'; tokens: number; unreported: readonly UsageSeat[] }>
  | Readonly<{ kind: 'legacy'; tokens: number; unreported: readonly UsageSeat[] }>
  | Readonly<{ kind: 'missing' }>;

export interface UsageCounterRow {
  counter: UsageCounter;
  amount: UsageAmount;
}

/**
 * The money the record supports: an unmetered run keeps its billing words and never gains a price,
 * an estimate is catalog arithmetic, `legacy` is a sum from before per-request pricing, and
 * `not-estimated` is the absence itself — never $0.00.
 */
export type UsageMoney =
  | Readonly<{ kind: 'unmetered'; label: string }>
  | Readonly<{
      kind: 'estimate';
      amount: number | null;
      knownSubtotal: number;
      completeness: RequestEstimate['completeness'];
      reasons: readonly RequestEstimateReason[];
      requests: number;
    }>
  | Readonly<{ kind: 'legacy'; amount: number; partial: boolean }>
  | Readonly<{ kind: 'not-estimated' }>;

export interface UsageRateRow {
  rates: RateSnapshot;
  requests: number;
}

export interface UsageBillingRow {
  tool: string;
  posture: RunnerBillingPosture;
  basis: BillingAttribution['basis'];
  /** Whether the run's own invocations established that posture, rather than a catalogued default. */
  proven: boolean;
}

export interface UsageDetailsView {
  /** The halt the run is parked on, when it is one this surface holds the figures for. */
  context: RecoveryContextDetails | null;
  counters: readonly UsageCounterRow[];
  money: UsageMoney;
  basis: CostAmountBasis;
  rates: readonly UsageRateRow[];
  billing: readonly UsageBillingRow[];
  /** A session that recorded neither tokens nor a cost breakdown has nothing to show. */
  empty: boolean;
}

export interface UsageDetailsInput {
  tokenUsage: TokenUsage | null;
  costBreakdown: CostBreakdown | null;
  /** The run's pending halt, whose context diagnosis this surface is the details view for. */
  recovery?: RecoveryIssue | null | undefined;
}

type UsageChannel = 'planner' | 'implementer' | 'escalation' | 'reviewer';

const CHANNEL_SEATS: ReadonlyArray<Readonly<{ channel: UsageChannel; seat: UsageSeat }>> = [
  { channel: 'planner', seat: 'plan' },
  { channel: 'implementer', seat: 'build' },
  { channel: 'escalation', seat: 'build' },
  { channel: 'reviewer', seat: 'review' },
];

type ChannelCounters = Readonly<Record<UsageCounter, number | undefined>>;

function channelCounters(usage: TokenUsage, channel: UsageChannel): ChannelCounters {
  switch (channel) {
    case 'planner':
      return {
        input: usage.plannerInput,
        output: usage.plannerOutput,
        cacheRead: usage.plannerCacheRead,
        cacheCreate: usage.plannerCacheCreate,
        reasoning: usage.plannerReasoning,
      };
    case 'implementer':
      return {
        input: usage.implementerInput,
        output: usage.implementerOutput,
        cacheRead: usage.implementerCacheRead,
        cacheCreate: usage.implementerCacheCreate,
        reasoning: usage.implementerReasoning,
      };
    case 'escalation':
      return {
        input: usage.escalationInput,
        output: usage.escalationOutput,
        cacheRead: usage.escalationCacheRead,
        cacheCreate: usage.escalationCacheCreate,
        reasoning: usage.escalationReasoning,
      };
    case 'reviewer':
      return {
        input: usage.reviewerInput,
        output: usage.reviewerOutput,
        cacheRead: usage.reviewerCacheRead,
        cacheCreate: usage.reviewerCacheCreate,
        reasoning: usage.reviewerReasoning,
      };
  }
}

function channelCoverage(
  usage: TokenUsage,
  channel: UsageChannel,
): RunnerCallCounterCoverage | undefined {
  switch (channel) {
    case 'planner':
      return usage.plannerCoverage;
    case 'implementer':
      return usage.implementerCoverage;
    case 'escalation':
      return usage.escalationCoverage;
    case 'reviewer':
      return usage.reviewerCoverage;
  }
}

/** A channel the run never used states nothing: no zero, and no partial. Coverage is use. */
function channelUsed(counters: ChannelCounters, coverage: RunnerCallCounterCoverage | undefined) {
  if (coverage !== undefined) return true;
  return USAGE_COUNTERS.some((counter) => (counters[counter] ?? 0) > 0);
}

// Historical counters without coverage cannot distinguish a reported zero from a default.
function counterState(
  value: number | undefined,
  declared: RunnerCallCounterCoverageState | undefined,
): RunnerCallCounterCoverageState {
  return value === undefined ? 'missing' : (declared ?? 'missing');
}

function deriveCounters(usage: TokenUsage | null): UsageCounterRow[] {
  if (usage === null)
    return USAGE_COUNTERS.map((counter) => ({ counter, amount: { kind: 'missing' } }));
  const active = CHANNEL_SEATS.map(({ channel, seat }) => ({
    seat,
    counters: channelCounters(usage, channel),
    coverage: channelCoverage(usage, channel),
  })).filter((entry) => channelUsed(entry.counters, entry.coverage));

  return USAGE_COUNTERS.map((counter) => {
    let tokens = 0;
    let reported = false;
    let legacy = false;
    const unreported: UsageSeat[] = [];
    for (const entry of active) {
      const value = entry.counters[counter];
      const state = counterState(value, entry.coverage?.[counter]);
      if (state === 'missing' || value === undefined) {
        // Positive counters from records written before coverage existed are still useful
        // evidence in explicitly opened details. Keep the number, but label the whole row
        // legacy so it cannot be mistaken for a provider-reported count.
        if (value !== undefined && value > 0 && entry.coverage?.[counter] === undefined) {
          tokens += value;
          legacy = true;
          continue;
        }
        unreported.push(entry.seat);
        continue;
      }
      tokens += value;
      reported = true;
      if (state === 'partial') unreported.push(entry.seat);
    }
    if (legacy) return { counter, amount: { kind: 'legacy', tokens, unreported } };
    if (!reported) return { counter, amount: { kind: 'missing' } };
    if (unreported.length === 0) return { counter, amount: { kind: 'reported', tokens } };
    return { counter, amount: { kind: 'partial', tokens, unreported: uniqueInOrder(unreported) } };
  });
}

function deriveMoney(breakdown: CostBreakdown | null): UsageMoney {
  if (breakdown === null) return { kind: 'not-estimated' };
  const unmetered = unmeteredRunCostLabel(breakdown);
  if (unmetered !== null) return { kind: 'unmetered', label: unmetered };
  const estimate = breakdown.requestEstimate;
  if (estimate !== undefined) {
    return {
      kind: 'estimate',
      amount: estimate.amount,
      knownSubtotal: estimate.knownSubtotal,
      completeness: estimate.completeness,
      reasons: estimate.reasons,
      requests: estimate.items.length,
    };
  }
  if (breakdown.hasPricedUsage !== true) return { kind: 'not-estimated' };
  return {
    kind: 'legacy',
    amount: breakdown.totalActualCost,
    partial: !costKnownFlags(breakdown).totalCostKnown,
  };
}

function deriveRates(breakdown: CostBreakdown | null): UsageRateRow[] {
  const rows = new Map<string, UsageRateRow>();
  for (const item of breakdown?.requestEstimate?.items ?? []) {
    const rates = item.rates;
    if (rates === undefined) continue;
    // One row per distinct rate card, whatever order a producer wrote its keys in.
    const key = [
      rates.source,
      rates.provider,
      rates.model,
      rates.inputPer1M,
      rates.outputPer1M,
      rates.cacheReadPer1M,
      rates.cacheWritePer1M,
      rates.selectedThresholdTokens,
      rates.rateAsOf,
    ].join('|');
    const existing = rows.get(key);
    if (existing === undefined) rows.set(key, { rates, requests: 1 });
    else rows.set(key, { rates, requests: existing.requests + 1 });
  }
  return [...rows.values()];
}

const PROVEN_BASES: ReadonlySet<BillingAttribution['basis']> = new Set([
  'enforced-channel',
  'observed-invocation',
  'local-transport',
]);

// What the run proved outranks what the catalog assumes: a tool enforced onto an API key is
// metered here even where its catalogued default reads subscription-included. With nothing proven
// the catalogued posture stands, and the row says it is a default.
function deriveBilling(breakdown: CostBreakdown | null): UsageBillingRow[] {
  return Object.entries(breakdown?.providerRunMetadata ?? {}).map(([tool, metadata]) => {
    const attribution = metadata.billingAttribution;
    const proven = attribution !== undefined && PROVEN_BASES.has(attribution.basis);
    return {
      tool,
      posture: proven && attribution !== undefined ? attribution.posture : metadata.billing,
      basis: attribution?.basis ?? 'legacy-unattributed',
      proven,
    };
  });
}

export function deriveUsageDetails(input: UsageDetailsInput): UsageDetailsView {
  const context = readRecoveryContext(input.recovery);
  return {
    context,
    counters: deriveCounters(input.tokenUsage),
    money: deriveMoney(input.costBreakdown),
    basis: costAmountBasis(input.costBreakdown ?? undefined),
    rates: deriveRates(input.costBreakdown),
    billing: deriveBilling(input.costBreakdown),
    empty: input.tokenUsage === null && input.costBreakdown === null && context === null,
  };
}

export type UsageTone = 'text' | 'textDim' | 'warning';

/** A logical row; the surface wraps all of its facts into scrollable lines. */
export interface UsageDetailRow {
  key: string;
  kind: 'header' | 'entry' | 'note' | 'spacer';
  label: string;
  facts: readonly string[];
  tone: UsageTone;
}

export function usageRowValue(row: UsageDetailRow): string {
  return row.facts.join(SOFT_SEP);
}

const COUNTER_LABELS: Readonly<Record<UsageCounter, string>> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheCreate: 'Cache write',
  reasoning: 'Reasoning',
};

const SEAT_LABELS: Readonly<Record<UsageSeat, string>> = {
  plan: 'PLAN',
  build: 'BUILD',
  review: 'REVIEW',
};

const REASON_WORDS: Readonly<Record<RequestEstimateReason, string>> = {
  'usage-not-reported': 'usage not reported',
  'unpriced-model': 'model has no published rate',
  'aggregate-boundary': 'usage arrived as a run total',
  'unknown-boundary': 'unknown usage boundary',
  'unknown-context-total': 'unknown context total',
  'unknown-output-count': 'unknown output count',
  'unknown-input-count': 'unknown input count',
  'unknown-category-split': 'unknown category split',
  'missing-cache-rate': 'no cache rate published',
  'reasoning-not-reported': 'reasoning not reported',
};

const BASIS_WORDS: Readonly<Record<BillingAttribution['basis'], string>> = {
  unknown: 'no evidence',
  'enforced-channel': 'enforced channel',
  'observed-invocation': 'observed invocation',
  'local-transport': 'local transport',
  'legacy-unattributed': 'legacy, unattributed',
};

const AMOUNT_BASIS_WORDS: Readonly<Record<CostAmountBasis, string>> = {
  'catalog-estimate': 'catalog estimate',
  unavailable: 'nothing recorded',
  'legacy-unattributed': 'legacy sum, no provenance',
};

const RATE_SOURCE_WORDS: Readonly<Record<RateSnapshot['source'], string>> = {
  'models-dev': 'models.dev',
  'bundled-fallback': 'bundled rates',
  unpriced: 'no published rate',
};

const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

export function formatUsageTokens(tokens: number): string {
  return String(tokens).replace(THOUSANDS, ',');
}

export function formatUsageAmount(amount: UsageAmount): string {
  if (amount.kind === 'missing') return 'not reported';
  if (amount.kind === 'reported') return formatUsageTokens(amount.tokens);
  if (amount.kind === 'legacy') {
    if (amount.unreported.length === 0) {
      return `${formatUsageTokens(amount.tokens)} (legacy; coverage unknown)`;
    }
    const seats = uniqueInOrder(amount.unreported.map((seat) => SEAT_LABELS[seat])).join(', ');
    return `${formatUsageTokens(amount.tokens)} (legacy; coverage unknown; no value from ${seats})`;
  }
  const seats = uniqueInOrder(amount.unreported.map((seat) => SEAT_LABELS[seat])).join(', ');
  return `${formatUsageTokens(amount.tokens)} + unknown (${seats})`;
}

/** The money in words. Absence is `not estimated`; it is never a zero amount. */
export function formatUsageMoney(money: UsageMoney): string {
  switch (money.kind) {
    case 'unmetered':
      return money.label;
    case 'not-estimated':
      return 'not estimated';
    case 'legacy':
      return money.partial ? `${formatCost(money.amount)} + unknown` : formatCost(money.amount);
    case 'estimate': {
      if (money.amount !== null) return formatCost(money.amount);
      if (money.knownSubtotal === 0) return 'not estimated';
      return `${formatCost(money.knownSubtotal)} + unknown`;
    }
  }
}

function rateFacts(row: UsageRateRow): string[] {
  const { rates } = row;
  const facts = [
    rates.model,
    RATE_SOURCE_WORDS[rates.source],
    `in ${formatCost(rates.inputPer1M)}/M`,
    `out ${formatCost(rates.outputPer1M)}/M`,
  ];
  if (rates.selectedThresholdTokens !== undefined) {
    facts.push(`tier ${formatUsageTokens(rates.selectedThresholdTokens)}`);
  }
  facts.push(rates.rateAsOf === undefined ? 'no rate date' : `rates of ${rates.rateAsOf}`);
  facts.push(row.requests === 1 ? '1 request' : `${row.requests} requests`);
  return facts;
}

function billingFacts(row: UsageBillingRow): string[] {
  const posture = billingWord(row.posture) ?? 'unknown';
  return [posture, row.proven ? BASIS_WORDS[row.basis] : `${BASIS_WORDS[row.basis]}, tool default`];
}

const ESTIMATE_NOTE = 'Catalog estimate from the rates below, not a confirmed amount.';
const LEGACY_NOTE = 'Recorded before per-request pricing; no rates were kept with it.';
const CONTEXT_NOTE = ['Nothing was sent to the seat', 'measured while the call was assembled'];
const NOT_MEASURED = 'not measured';
const NOT_RECORDED = 'not recorded';
const BUDGET_SOURCE_WORDS: Readonly<Record<RecoveryContextBudgetSource, string>> = {
  configured: 'configured limit',
  'observed-active': 'active provider limit',
  'application-default': 'application default',
};
const OMITTED_OPTION_WORDS: Readonly<Record<RecoveryContextOmittedOption, string>> = {
  temperature: 'temperature',
  reasoning_effort: 'reasoning effort',
  'stream_options.include_usage': 'stream usage',
};

function header(key: string, label: string, first = false): UsageDetailRow[] {
  const heading: UsageDetailRow = { key, kind: 'header', label, facts: [], tone: 'textDim' };
  if (first) return [heading];
  return [{ key: `${key}:gap`, kind: 'spacer', label: '', facts: [], tone: 'textDim' }, heading];
}

function entry(key: string, label: string, facts: string[], tone: UsageTone): UsageDetailRow {
  return { key, kind: 'entry', label, facts, tone };
}

/** `140,000` reads as a count only next to what it counts; the head figure carries the unit. */
function tokenFact(label: string, tokens: number | null): string | null {
  return tokens === null ? null : `${label} ${formatUsageTokens(tokens)}`;
}

function measuredFacts(head: number | null, tail: ReadonlyArray<string | null>): string[] {
  const facts = [head === null ? null : `${formatUsageTokens(head)} tokens`, ...tail].filter(
    (fact): fact is string => fact !== null,
  );
  return facts.length === 0 ? [NOT_MEASURED] : facts;
}

/**
 * What the halt measured, in the order it is read: which seat refused and why, what it was never
 * given, then the two figures the refusal compared. A measurement nobody took says so.
 */
function contextRows(context: RecoveryContextDetails | null): UsageDetailRow[] {
  if (context === null) return [];
  const needed = measuredFacts(context.requiredTokens, [
    tokenFact('input', context.inputEstimate),
    tokenFact('margin', context.estimationMargin),
    tokenFact('output reserve', context.requiredOutputTokens),
  ]);
  const available = measuredFacts(context.availableTokens, [
    tokenFact('output cap', context.outputCap),
  ]);
  const rows: UsageDetailRow[] = [
    ...header('context', 'Context', true),
    entry('context:seat', 'Seat', [recoveryContextSeatLabel(context)], 'text'),
    entry(
      'context:model',
      'Model',
      [context.model ?? NOT_RECORDED],
      context.model === null ? 'textDim' : 'text',
    ),
    entry('context:cause', 'Cause', [recoveryContextCauseWords(context)], 'warning'),
  ];
  if (context.missingSections === null) {
    rows.push(entry('context:missing', 'Missing', [NOT_RECORDED], 'textDim'));
  } else if (context.missingSections.length > 0) {
    rows.push(entry('context:missing', 'Missing', [...context.missingSections], 'text'));
  }
  rows.push(
    entry('context:needed', 'Needed', needed, needed[0] === NOT_MEASURED ? 'textDim' : 'text'),
    entry(
      'context:available',
      'Available',
      available,
      available[0] === NOT_MEASURED ? 'textDim' : 'text',
    ),
  );
  if (context.budgetSource !== null) {
    rows.push(
      entry(
        'context:budget-source',
        'Limit source',
        [BUDGET_SOURCE_WORDS[context.budgetSource]],
        'text',
      ),
    );
  }
  if (context.omittedRequestOptions !== null) {
    rows.push(
      entry(
        'context:omitted-options',
        'Omitted options',
        context.omittedRequestOptions.length === 0
          ? ['none']
          : context.omittedRequestOptions.map((option) => OMITTED_OPTION_WORDS[option]),
        context.omittedRequestOptions.length === 0 ? 'textDim' : 'text',
      ),
    );
  }
  rows.push({ key: 'context:note', kind: 'note', label: '', facts: CONTEXT_NOTE, tone: 'textDim' });
  return rows;
}

/** The rows the view paints, in reading order. One fact per row; absence is a word, never a zero. */
export function usageDetailRows(view: UsageDetailsView): UsageDetailRow[] {
  if (view.empty) {
    return [
      { key: 'empty', kind: 'note', label: '', facts: ['No usage recorded'], tone: 'textDim' },
    ];
  }
  const rows: UsageDetailRow[] = [...contextRows(view.context)];
  rows.push(...header('tokens', 'Tokens', rows.length === 0));
  for (const row of view.counters) {
    rows.push(
      entry(
        `counter:${row.counter}`,
        COUNTER_LABELS[row.counter],
        [formatUsageAmount(row.amount)],
        row.amount.kind === 'reported' ? 'text' : 'textDim',
      ),
    );
  }

  rows.push(...header('money', 'Money'));
  rows.push(
    entry(
      'money:amount',
      'Amount',
      [formatUsageMoney(view.money)],
      view.money.kind === 'not-estimated' ? 'textDim' : 'text',
    ),
  );
  // A run with no amount has no basis to state: `unmetered` carries its billing words instead, and
  // `not-estimated` is the absence itself.
  if (view.money.kind === 'estimate' || view.money.kind === 'legacy') {
    rows.push(
      entry(
        'money:basis',
        'Basis',
        [AMOUNT_BASIS_WORDS[view.basis]],
        view.basis === 'catalog-estimate' ? 'text' : 'textDim',
      ),
    );
  }
  if (view.money.kind === 'estimate' && view.money.completeness !== 'complete') {
    rows.push(
      entry(
        'money:reasons',
        'Incomplete',
        view.money.reasons.map((reason) => REASON_WORDS[reason]),
        'text',
      ),
    );
  }
  if (view.money.kind === 'estimate' || view.money.kind === 'legacy') {
    rows.push({
      key: 'money:note',
      kind: 'note',
      label: '',
      facts: [view.money.kind === 'legacy' ? LEGACY_NOTE : ESTIMATE_NOTE],
      tone: 'textDim',
    });
  }

  rows.push(...header('rates', 'Rates'));
  if (view.rates.length === 0) {
    rows.push(entry('rates:none', 'Source', ['not recorded'], 'textDim'));
  }
  for (const [index, row] of view.rates.entries()) {
    rows.push(entry(`rates:${index}`, row.rates.provider, rateFacts(row), 'text'));
  }

  rows.push(...header('billing', 'Billing'));
  if (view.billing.length === 0) {
    rows.push(entry('billing:none', 'Channel', ['not recorded'], 'textDim'));
  }
  for (const row of view.billing) {
    rows.push(
      entry(`billing:${row.tool}`, row.tool, billingFacts(row), row.proven ? 'text' : 'textDim'),
    );
  }
  return rows;
}
