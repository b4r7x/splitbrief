import { formatCost } from '../../../core/formatting.js';
import type {
  RequestEstimateReason,
  BillingAttribution,
  CostAmountBasis,
  RateSnapshot,
} from '../../../core/schemas/cost.js';
import { uniqueInOrder } from '../../../utils/collections.js';
import type { UsageAmount, UsageMoney } from './derive.js';
import type { UsageCounter, UsageSeat } from './recovery-context.js';

export type UsageTone = 'text' | 'textDim' | 'warning';

/** A logical row; the surface wraps all of its facts into scrollable lines. */
export interface UsageDetailRow {
  key: string;
  kind: 'header' | 'entry' | 'note' | 'spacer';
  label: string;
  facts: readonly string[];
  tone: UsageTone;
}

export const COUNTER_LABELS: Readonly<Record<UsageCounter, string>> = {
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

export const REASON_WORDS: Readonly<Record<RequestEstimateReason, string>> = {
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

export const BASIS_WORDS: Readonly<Record<BillingAttribution['basis'], string>> = {
  unknown: 'no evidence',
  'enforced-channel': 'enforced channel',
  'observed-invocation': 'observed invocation',
  'local-transport': 'local transport',
  'legacy-unattributed': 'legacy, unattributed',
};

export const AMOUNT_BASIS_WORDS: Readonly<Record<CostAmountBasis, string>> = {
  'catalog-estimate': 'catalog estimate',
  unavailable: 'nothing recorded',
  'legacy-unattributed': 'legacy sum, no provenance',
};

export const RATE_SOURCE_WORDS: Readonly<Record<RateSnapshot['source'], string>> = {
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
      if (!statesAmount(money)) return 'not estimated';
      if (money.amount !== null) return formatCost(money.amount);
      return `${formatCost(money.knownSubtotal)} + unknown`;
    }
  }
}

/** Whether the money states an amount; an estimate that priced no part of any request does not. */
export function statesAmount(money: UsageMoney): boolean {
  if (money.kind === 'not-estimated') return false;
  if (money.kind !== 'estimate') return true;
  return money.amount !== null || money.knownSubtotal > 0;
}
