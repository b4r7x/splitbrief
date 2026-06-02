import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { CostPrediction } from '../../core/schemas/summary.js';

interface CostGateInput {
  mode: WorkflowMode | undefined;
  prediction: CostPrediction | null;
  costGateEnabled: boolean;
}

export type CostGateDecision = 'gate' | 'skip';

export function decideCostGate(input: CostGateInput): CostGateDecision {
  if (!input.costGateEnabled) return 'skip';
  if (input.mode === 'instant' || input.mode === 'quick') return 'skip';
  if (!input.prediction) return 'skip';
  const deterministic = input.prediction.deterministic;
  if (!deterministic) return 'skip';
  if (deterministic.totals.knownActualEstimate === null) return 'skip';
  return 'gate';
}
