import { formatCost } from '../formatting.js';
import type { CostBreakdown, CostPrediction } from '../schemas/summary.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';

const STATUS_SEPARATOR = ' \u00b7 ';
const STATUS_SPLIT_GAP = 4;
const NARROW_STATUS_WIDTH = 60;

export type CostChromePricingState = 'priced' | 'mixed' | 'local' | 'unpriced' | 'n/a';

export interface CostStatusLineLayoutInput {
  renderWidth: number;
  paddingX: number;
  spentText: string;
  completedCount: number;
  totalActualCost: number;
  prediction: CostPrediction | null;
  totalTasks: number;
  pricingState: CostChromePricingState;
  maxBudget: number | undefined;
  plannerInput: number;
  totalInput: number;
  totalCacheRead: number;
  localRate: number;
  routedTasks: number;
  costBreakdown: CostBreakdown | null;
}

export type CostStatusLineLayout =
  | { kind: 'split'; left: string; right: string }
  | { kind: 'single'; line: string };

export function formatProjected(
  completedCount: number,
  totalActualCost: number,
  prediction: CostPrediction | null,
  totalTasks: number,
  pricingState: CostChromePricingState = 'priced',
): string {
  if (pricingState !== 'priced' && pricingState !== 'mixed') return 'proj n/a';
  if (completedCount > 0) {
    const projected = (totalActualCost / completedCount) * totalTasks;
    return `proj ${formatCost(projected)}`;
  }
  if (prediction !== null) {
    return `proj ${formatCost(prediction.expectedCost)}`;
  }
  return 'proj n/a';
}

export function formatBudget(maxBudget: number | undefined): string {
  if (maxBudget === undefined) return '';
  return formatCost(maxBudget);
}

export function formatPlanPct(plannerInput: number, totalInput: number): number {
  if (totalInput === 0) return 0;
  return Math.round((plannerInput / totalInput) * 100);
}

export function buildStatusLine(parts: string[]): string {
  return parts.filter(p => p.length > 0).join(STATUS_SEPARATOR);
}

function fitStatusParts(parts: string[], maxWidth: number): string {
  const accepted: string[] = [];
  for (const part of parts) {
    const candidate = buildStatusLine([...accepted, part]);
    if (candidate.length > maxWidth) continue;
    accepted.push(part);
  }
  return buildStatusLine(accepted);
}

function formatLocalRate(localRate: number, routedTasks: number): string {
  if (routedTasks <= 0) return '';
  return `local ${Math.round(localRate)}%`;
}

function formatSavings(costBreakdown: CostBreakdown | null): string {
  if (costBreakdown === null || !(costBreakdown.hasSavingsEstimate ?? false) || costBreakdown.savingsAmount <= 0) return '';
  return `saved ~${formatCost(costBreakdown.savingsAmount)}`;
}

export function buildCostStatusLineLayout(input: CostStatusLineLayoutInput): CostStatusLineLayout {
  const projText = formatProjected(
    input.completedCount,
    input.totalActualCost,
    input.prediction,
    input.totalTasks,
    input.pricingState,
  );
  const budgetText = formatBudget(input.maxBudget);
  const planPct = input.totalInput > 0 ? formatPlanPct(input.plannerInput, input.totalInput) : null;
  const cacheText = formatCacheHitPct(input.totalCacheRead > 0 ? input.totalCacheRead : undefined, input.totalInput);

  const isNarrow = input.renderWidth < NARROW_STATUS_WIDTH;
  const contentWidth = Math.max(1, input.renderWidth - (input.paddingX * 2));
  const costParts = [
    input.spentText ? `spent ${input.spentText}` : '',
    projText,
    !isNarrow && budgetText ? `budget ${budgetText}` : '',
  ];
  const efficiencyParts = isNarrow ? [] : [
    formatLocalRate(input.localRate, input.routedTasks),
    formatSavings(input.costBreakdown),
    planPct !== null ? `plan ${planPct}%` : '',
    cacheText === 'cache n/a' ? '' : cacheText,
  ];

  const left = buildStatusLine(costParts);
  const right = fitStatusParts(efficiencyParts, Math.max(0, contentWidth - left.length - STATUS_SPLIT_GAP));
  if (right.length > 0 && left.length + right.length + STATUS_SPLIT_GAP <= contentWidth) {
    return { kind: 'split', left, right };
  }

  return {
    kind: 'single',
    line: truncateWithEllipsis(buildStatusLine([...costParts, ...efficiencyParts]), contentWidth),
  };
}

export function formatCacheHitPct(cacheRead: number | undefined, input: number): string {
  if (cacheRead === undefined || cacheRead === 0 || input === 0) return 'cache n/a';
  const total = cacheRead + input;
  return `cache ${Math.round((cacheRead / total) * 100)}%`;
}

export function hasDisplayableCostPrediction(prediction: CostPrediction | undefined): prediction is CostPrediction {
  if (!prediction) return false;
  return prediction.estimatedTasks > 0 || prediction.expectedCost > 0 || (prediction.deterministic?.taskCount ?? 0) > 0;
}

export function formatCostPredictionUnknownReasons(reasons: string[]): string {
  if (reasons.length === 0) return '';
  return `Unknown: ${reasons.join(', ')}`;
}

export function plannerEstimateReviewLine(prediction: CostPrediction): string | null {
  const review = prediction.plannerEstimateReview;
  if (!review) return null;
  if (review.status === 'running') return 'Planner estimate review: extra planner call running';
  if (review.status === 'unavailable') return 'Planner estimate review: unavailable; deterministic estimate remains usable';
  return `Planner estimate review: extra planner call completed (${review.classification ?? 'unclassified'})`;
}
