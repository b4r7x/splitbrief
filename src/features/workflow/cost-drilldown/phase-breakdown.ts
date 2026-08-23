import type { PhaseTokens } from '../../../stores/workflow/tokens.js';
import { formatCost, formatTokensShort } from '../../../core/formatting.js';
import { calculateUsageCost } from '../../../engine/providers/cost-math.js';
import type { ResolvedPricing } from '../../../engine/providers/pricing-resolver.js';
import { phaseCostRole } from '../../../core/phases.js';
import { PhaseSchema, type Phase } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActiveRunnerRole } from '../../../core/runners/cli-tool-catalog.js';
import {
  foldReviewerIntoPlanner,
  type SeatTokenTotals,
} from '../../../core/providers/seat-totals.js';

const ZERO_ROLE_TOKENS: SeatTokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

export type PhaseRowData = PhaseTokens & { phase: Phase };

export type PhaseRow = PhaseRowData & { cost: number };

export function buildPhaseRows(
  perPhase: Partial<Record<Phase, PhaseTokens>>,
  costForRow: (row: PhaseRowData) => number = () => 0,
): PhaseRow[] {
  return Object.entries(perPhase)
    .flatMap(([phase, data]) => {
      if (!data) return [];
      const parsed = PhaseSchema.safeParse(phase);
      if (!parsed.success) return [];
      const phaseRow = parsed.data;
      const typedRow = { ...data, phase: phaseRow };
      return [{ ...typedRow, cost: costForRow(typedRow) }];
    })
    .sort((a, b) => b.cost - a.cost);
}

export function formatCacheCreateTokens(cacheCreate: number): string {
  if (cacheCreate === 0) return '';
  if (cacheCreate > 1000) return `create ${formatTokensShort(cacheCreate)}`;
  return `create ${cacheCreate}`;
}

export function formatInputOutputSplit(options: {
  inputTokens: number;
  outputTokens: number;
}): string {
  const { inputTokens, outputTokens } = options;
  const total = inputTokens + outputTokens;
  if (total > 1000) {
    return `in: ${(inputTokens / 1000).toFixed(1)}k / out: ${(outputTokens / 1000).toFixed(1)}k`;
  }
  return `in: ${inputTokens} / out: ${outputTokens}`;
}

export function formatPhaseCost(options: {
  cost: number;
  isPhasePriced: boolean;
  pricingMode: string | null;
}): string {
  const { cost, isPhasePriced, pricingMode } = options;
  if (cost > 0 || isPhasePriced) return formatCost(cost);
  if (pricingMode === 'unpriced-local') return 'local';
  if (pricingMode === 'unpriced-cli' || pricingMode === 'unpriced-meta') return 'unpriced';
  return 'n/a';
}

export function formatSplitPhaseCost(options: {
  cost: number;
  seats: { priced: boolean; mode: string | null }[];
}): string {
  const { cost, seats } = options;
  if (seats.every((seat) => seat.priced)) return formatCost(cost);
  if (seats.every((seat) => !seat.priced)) {
    return seats.every((seat) => seat.mode === 'unpriced-local') ? 'local' : 'n/a';
  }
  if (cost > 0) return `${formatCost(cost)} + partial`;
  return 'partial';
}

export function hasRoleSplit(row: PhaseRowData): boolean {
  return (
    row.plannerInputTokens !== undefined ||
    row.plannerOutputTokens !== undefined ||
    row.plannerCacheReadTokens !== undefined ||
    row.plannerCacheCreateTokens !== undefined ||
    row.implementerInputTokens !== undefined ||
    row.implementerOutputTokens !== undefined ||
    row.implementerCacheReadTokens !== undefined ||
    row.implementerCacheCreateTokens !== undefined ||
    row.reviewerInputTokens !== undefined ||
    row.reviewerOutputTokens !== undefined ||
    row.reviewerCacheReadTokens !== undefined ||
    row.reviewerCacheCreateTokens !== undefined
  );
}

function roleTokens(options: {
  row: PhaseRowData;
  role: ActiveRunnerRole;
  reviewerHasOwnSeat: boolean;
}): SeatTokenTotals {
  const { row, role, reviewerHasOwnSeat } = options;
  const reviewer = {
    input: row.reviewerInputTokens ?? 0,
    output: row.reviewerOutputTokens ?? 0,
    cacheRead: row.reviewerCacheReadTokens ?? 0,
    cacheCreate: row.reviewerCacheCreateTokens ?? 0,
  };
  switch (role) {
    case 'reviewer':
      return reviewerHasOwnSeat ? reviewer : ZERO_ROLE_TOKENS;
    case 'planner':
      return foldReviewerIntoPlanner({
        base: {
          input: row.plannerInputTokens ?? 0,
          output: row.plannerOutputTokens ?? 0,
          cacheRead: row.plannerCacheReadTokens ?? 0,
          cacheCreate: row.plannerCacheCreateTokens ?? 0,
        },
        reviewer,
        foldReviewerIn: !reviewerHasOwnSeat,
      });
    case 'implementer':
      return {
        input: row.implementerInputTokens ?? 0,
        output: row.implementerOutputTokens ?? 0,
        cacheRead: row.implementerCacheReadTokens ?? 0,
        cacheCreate: row.implementerCacheCreateTokens ?? 0,
      };
    default:
      return assertNever(role);
  }
}

export function roleHasTokens(options: {
  row: PhaseRowData;
  role: ActiveRunnerRole;
  reviewerHasOwnSeat: boolean;
}): boolean {
  const { row, role, reviewerHasOwnSeat } = options;
  if (!hasRoleSplit(row)) {
    return role === 'reviewer' ? false : phaseCostRole(row.phase) === role;
  }
  const tokens = roleTokens({ row, role, reviewerHasOwnSeat });
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate > 0;
}

export function calculatePhaseRowCost(options: {
  row: PhaseRowData;
  plannerPricing: ResolvedPricing | null;
  implementerPricing: ResolvedPricing | null;
  reviewerPricing: ResolvedPricing | null;
  reviewerHasOwnSeat: boolean;
}): number {
  const { row, plannerPricing, implementerPricing, reviewerPricing, reviewerHasOwnSeat } = options;
  const role = phaseCostRole(row.phase);
  const split = hasRoleSplit(row);
  const unsplit = {
    input: row.inputTokens,
    output: row.outputTokens,
    cacheRead: row.cacheReadTokens,
    cacheCreate: row.cacheCreateTokens,
  };
  const priced = (
    [
      ['planner', plannerPricing],
      ['implementer', implementerPricing],
      ['reviewer', reviewerPricing],
    ] as const
  ).map(([seat, pricing]) => {
    if (pricing === null) return 0;
    const tokens = split
      ? roleTokens({ row, role: seat, reviewerHasOwnSeat })
      : role === seat
        ? unsplit
        : ZERO_ROLE_TOKENS;
    return calculateUsageCost({
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheCreateTokens: tokens.cacheCreate,
      pricing,
    });
  });
  return priced.reduce((total, cost) => total + cost, 0);
}

export function pricingForPhase(
  phase: Phase,
  plannerPricing: ResolvedPricing | null,
  implementerPricing: ResolvedPricing | null,
): ResolvedPricing | null {
  const role = phaseCostRole(phase);
  if (role === 'planner') return plannerPricing;
  if (role === 'implementer') return implementerPricing;
  return null;
}
