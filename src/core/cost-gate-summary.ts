import { formatCost } from './formatting.js';
import type { CostPrediction } from './schemas/summary.js';

export interface CostGateSummary {
  taskCount: number;
  estimatedCost: string;
  allPlannerCost: string;
  estimatedSavings: string;
  savingsPercentage: number;
}

export function formatCostGateSummary(prediction: CostPrediction): CostGateSummary | null {
  const deterministic = prediction.deterministic;
  if (!deterministic) return null;
  const estimated = deterministic.totals.knownActualEstimate;
  const hypothetical = deterministic.totals.hypotheticalAllPlanner;
  if (estimated === null) return null;
  const savings = hypothetical !== null ? hypothetical - estimated : 0;
  const pct = hypothetical !== null && hypothetical > 0 ? (savings / hypothetical) * 100 : 0;
  return {
    taskCount: deterministic.taskCount,
    estimatedCost: formatCost(estimated),
    allPlannerCost: hypothetical !== null ? `~${formatCost(hypothetical)}` : 'n/a',
    estimatedSavings: formatCost(Math.max(0, savings)),
    savingsPercentage: Math.max(0, Math.round(pct)),
  };
}
