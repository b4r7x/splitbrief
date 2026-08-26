import type { CrewSeatId } from '../../../core/crew/identity.js';
import { formatCost } from '../../../core/formatting.js';
import { splitSeatTokenTotals, type SeatTokenTotals } from '../../../core/providers/seat-totals.js';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import { calculateUsageCost } from '../../../engine/providers/cost-math.js';
import type { ResolvedPricing } from '../../../engine/providers/pricing-resolver.js';
import { glyph } from '../../../lib/glyphs.js';
import type { tokensStore } from '../../../stores/workflow/tokens.js';

type PricingContext = NonNullable<ReturnType<typeof tokensStore.get>['pricingContext']>;

export type SeatRow = {
  seat: CrewSeatId;
  cost: string;
  share: number;
  local: boolean;
  tokens: number;
};

export function costBar(input: { share: number; width: number }): string {
  const width = Math.max(0, input.width);
  const filled = Math.min(width, Math.max(0, Math.round(input.share * width)));
  return glyph('barFilled').repeat(filled) + ' '.repeat(width - filled);
}

function seatCost(totals: SeatTokenTotals, pricing: ResolvedPricing | null): number | null {
  if (pricing === null || !pricing.isPriced) return null;
  return calculateUsageCost({
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheCreateTokens: totals.cacheCreate,
    pricing,
  });
}

export function buildSeatRows(input: {
  tokenUsage: TokenUsage;
  pricingContext: PricingContext | null;
  pricing: {
    planner: ResolvedPricing | null;
    implementer: ResolvedPricing | null;
    reviewer: ResolvedPricing | null;
  };
}): SeatRow[] {
  const { tokenUsage, pricingContext, pricing } = input;
  const split = splitSeatTokenTotals({ tokenUsage, reviewerTool: pricingContext?.reviewerTool });
  const build: SeatTokenTotals = {
    input: tokenUsage.implementerInput,
    output: tokenUsage.implementerOutput,
    cacheRead: tokenUsage.implementerCacheRead ?? 0,
    cacheCreate: tokenUsage.implementerCacheCreate ?? 0,
  };
  const seats: { seat: CrewSeatId; totals: SeatTokenTotals; pricing: ResolvedPricing | null }[] = [
    { seat: 'plan', totals: split.planner, pricing: pricing.planner },
    { seat: 'build', totals: build, pricing: pricing.implementer },
    ...(split.reviewer === undefined
      ? []
      : [{ seat: 'review' as const, totals: split.reviewer, pricing: pricing.reviewer }]),
  ];
  const priced = seats.map((entry) => ({
    seat: entry.seat,
    cost: seatCost(entry.totals, entry.pricing),
    tokens:
      entry.totals.input + entry.totals.output + entry.totals.cacheRead + entry.totals.cacheCreate,
  }));
  const total = priced.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  return priced.map(({ seat, cost, tokens }) =>
    cost === null
      ? { seat, cost: 'local', share: 0, local: true, tokens }
      : { seat, cost: formatCost(cost), share: total > 0 ? cost / total : 0, local: false, tokens },
  );
}
