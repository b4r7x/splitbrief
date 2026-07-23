import type { PhaseTokens } from '../../../stores/workflow/tokens.js';
import { formatCost, formatTokensShort } from '../../../core/formatting.js';
import { calculateUsageCost } from '../../../engine/providers/cost-math.js';
import type { ResolvedPricing } from '../../../engine/providers/pricing-resolver.js';
import { phaseCostRole } from '../../../core/phases.js';
import { PhaseSchema, type Phase } from '../../../core/schemas/enums.js';

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
  plannerPriced: boolean;
  implementerPriced: boolean;
  plannerMode: string | null;
  implementerMode: string | null;
}): string {
  const { cost, plannerPriced, implementerPriced, plannerMode, implementerMode } = options;
  if (plannerPriced && implementerPriced) return formatCost(cost);
  if (!plannerPriced && !implementerPriced) {
    if (plannerMode === 'unpriced-local' && implementerMode === 'unpriced-local') return 'local';
    return 'n/a';
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
    row.implementerCacheCreateTokens !== undefined
  );
}

export function roleHasTokens(row: PhaseRowData, role: 'planner' | 'implementer'): boolean {
  if (!hasRoleSplit(row)) return phaseCostRole(row.phase) === role;
  if (role === 'planner') {
    return (
      (row.plannerInputTokens ?? 0) +
        (row.plannerOutputTokens ?? 0) +
        (row.plannerCacheReadTokens ?? 0) +
        (row.plannerCacheCreateTokens ?? 0) >
      0
    );
  }
  return (
    (row.implementerInputTokens ?? 0) +
      (row.implementerOutputTokens ?? 0) +
      (row.implementerCacheReadTokens ?? 0) +
      (row.implementerCacheCreateTokens ?? 0) >
    0
  );
}

export function calculatePhaseRowCost(
  row: PhaseRowData,
  plannerPricing: ResolvedPricing | null,
  implementerPricing: ResolvedPricing | null,
): number {
  const role = phaseCostRole(row.phase);
  const split = hasRoleSplit(row);
  const plannerTokens = {
    input: split ? (row.plannerInputTokens ?? 0) : role === 'planner' ? row.inputTokens : 0,
    output: split ? (row.plannerOutputTokens ?? 0) : role === 'planner' ? row.outputTokens : 0,
    cacheRead: split
      ? (row.plannerCacheReadTokens ?? 0)
      : role === 'planner'
        ? row.cacheReadTokens
        : 0,
    cacheCreate: split
      ? (row.plannerCacheCreateTokens ?? 0)
      : role === 'planner'
        ? row.cacheCreateTokens
        : 0,
  };
  const implementerTokens = {
    input: split ? (row.implementerInputTokens ?? 0) : role === 'implementer' ? row.inputTokens : 0,
    output: split
      ? (row.implementerOutputTokens ?? 0)
      : role === 'implementer'
        ? row.outputTokens
        : 0,
    cacheRead: split
      ? (row.implementerCacheReadTokens ?? 0)
      : role === 'implementer'
        ? row.cacheReadTokens
        : 0,
    cacheCreate: split
      ? (row.implementerCacheCreateTokens ?? 0)
      : role === 'implementer'
        ? row.cacheCreateTokens
        : 0,
  };
  const plannerCost = plannerPricing
    ? calculateUsageCost({
        inputTokens: plannerTokens.input,
        outputTokens: plannerTokens.output,
        cacheReadTokens: plannerTokens.cacheRead,
        cacheCreateTokens: plannerTokens.cacheCreate,
        pricing: plannerPricing,
      })
    : 0;
  const implementerCost = implementerPricing
    ? calculateUsageCost({
        inputTokens: implementerTokens.input,
        outputTokens: implementerTokens.output,
        cacheReadTokens: implementerTokens.cacheRead,
        cacheCreateTokens: implementerTokens.cacheCreate,
        pricing: implementerPricing,
      })
    : 0;
  return plannerCost + implementerCost;
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
