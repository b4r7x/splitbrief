import {
  parseRunnerIdentityKey,
  getRunnerIdentityDisplayName,
} from '../../../core/providers/catalog.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import {
  type RequestEstimate,
  type RequestEstimateReason,
  type RateSnapshot,
  type BillingAttribution,
  type CostAmountBasis,
  type CostBreakdown,
  unmeteredRunCostLabel,
  costKnownFlags,
  costAmountBasis,
} from '../../../core/schemas/cost.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type {
  RunnerCallCounterCoverage,
  RunnerCallCounterCoverageState,
} from '../../../core/schemas/runner-call.js';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import {
  type UsageSeat,
  type UsageCounter,
  type RecoveryContextDetails,
  USAGE_COUNTERS,
  readRecoveryContext,
} from './recovery-context.js';

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
  key: string;
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

// A kind-qualified key is named in the words of the identity it kept — a custom API provider stays
// literal — while a legacy name-only key stays exactly as recorded.
export function runnerKeyLabel(key: string): string {
  const { kind, id } = parseRunnerIdentityKey(key);
  return kind === undefined ? id : getRunnerIdentityDisplayName(kind, id);
}

// What the run proved outranks what the catalog assumes: a tool enforced onto an API key is
// metered here even where its catalogued default reads subscription-included. With nothing proven
// the catalogued posture stands, and the row says it is a default.
function deriveBilling(breakdown: CostBreakdown | null): UsageBillingRow[] {
  return Object.entries(breakdown?.providerRunMetadata ?? {}).map(([key, metadata]) => {
    const attribution = metadata.billingAttribution;
    const proven = attribution !== undefined && PROVEN_BASES.has(attribution.basis);
    return {
      key,
      tool: runnerKeyLabel(key),
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
