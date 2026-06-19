import { formatCost } from './formatting.js';
import type { CostPrediction } from './schemas/summary.js';

export interface CostGateSummary {
  taskCount: number;
  estimateLabel: string;
  estimatedCost: string;
  allPlannerLabel: string;
  allPlannerCost: string;
  savingsLabel: string;
  estimatedSavings: string;
  savingsPercentage: number;
  scopeNote: string | null;
}

export function formatCostGateSummary(prediction: CostPrediction): CostGateSummary | null {
  const deterministic = prediction.deterministic;
  if (!deterministic) return null;
  const estimated = deterministic.totals.knownActualEstimate;
  const hypothetical = deterministic.totals.hypotheticalAllPlanner;
  if (estimated === null && hypothetical === null) return null;
  const savings = estimated !== null && hypothetical !== null ? hypothetical - estimated : null;
  const pct =
    savings !== null && hypothetical !== null && hypothetical > 0
      ? (savings / hypothetical) * 100
      : 0;
  return {
    taskCount: deterministic.taskCount,
    estimateLabel: deterministic.estimateScope === 'prompt-input-only' ? 'Prompt input' : 'Est.',
    estimatedCost: estimated !== null ? formatCost(estimated) : 'n/a',
    allPlannerLabel:
      deterministic.estimateScope === 'prompt-input-only' ? 'All-planner prompt' : 'All-planner',
    allPlannerCost: hypothetical !== null ? `~${formatCost(hypothetical)}` : 'n/a',
    savingsLabel: deterministic.estimateScope === 'prompt-input-only' ? 'Prompt saving' : 'Saving',
    estimatedSavings: savings !== null ? formatCost(Math.max(0, savings)) : 'n/a',
    savingsPercentage: Math.max(0, Math.round(pct)),
    scopeNote:
      deterministic.estimateScope === 'prompt-input-only'
        ? 'Output, retries, validation reruns, and escalation are tracked at runtime.'
        : null,
  };
}
