import type { RunnerBillingPosture } from '../../../core/runners/billing.js';
import type {
  BillingAttribution,
  CostAmountBasis,
  CostBreakdown,
  RateSnapshot,
  RequestEstimate,
  RequestEstimateReason,
} from '../../../core/schemas/cost.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { RecoveryContextDetails, UsageCounter, UsageSeat } from './recovery-context.js';

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
