import { formatCost } from '../../../core/formatting.js';
import {
  formatCostPredictionUnknownReasons,
  hasDisplayableCostPrediction,
  plannerEstimateReviewLine,
} from '../layout/cost-chrome.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { ConversationRow } from './types.js';
import { row, wrapRows } from './row-format.js';

export function costPredictionRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'cost_prediction' }>,
  width: number,
): ConversationRow[] {
  const prediction = event.prediction;
  if (!hasDisplayableCostPrediction(prediction)) {
    return [row(`${keyPrefix}-na`, 'prediction n/a', 'textDim')];
  }

  const deterministic = prediction.deterministic;
  const reviewLine = plannerEstimateReviewLine(prediction);
  const rows: ConversationRow[] = [row(`${keyPrefix}-title`, 'Cost prediction', 'accent', true)];

  if (!deterministic) {
    rows.push(
      row(
        `${keyPrefix}-heuristic`,
        'Low: all local · Expected: ~15% escalation · High: ~40% escalation',
        'textDim',
      ),
    );
    rows.push(
      row(
        `${keyPrefix}-costs`,
        `Low: ${formatCost(prediction.lowCost)} (all local) Expected: ${formatCost(prediction.expectedCost)} High: ${formatCost(prediction.highCost)}`,
        'textDim',
      ),
    );
    rows.push(
      row(
        `${keyPrefix}-tools`,
        `Planner: ${getProviderDisplayName(prediction.plannerTool)} Implementer: ${getProviderDisplayName(prediction.implementerTool)} (${prediction.estimatedTasks} tasks)`,
        'textDim',
      ),
    );
    if (reviewLine)
      rows.push(
        row(
          `${keyPrefix}-review`,
          reviewLine,
          prediction.plannerEstimateReview?.status === 'unavailable' ? 'warning' : 'planner',
        ),
      );
    return wrapRows(rows, width);
  }

  const unknownReasons = formatCostPredictionUnknownReasons(deterministic.totals.unknownCostReason);
  rows.push(
    row(
      `${keyPrefix}-desc`,
      'Deterministic estimate from task briefs and routing preview',
      'textDim',
    ),
  );
  rows.push(
    row(
      `${keyPrefix}-totals`,
      `   Implementer: ${formatNullableCost(deterministic.totals.knownActualEstimate)} All planner: ${formatNullableCost(deterministic.totals.hypotheticalAllPlanner)} Savings: ${formatNullableCost(deterministic.totals.estimatedSavings)}`,
      'textDim',
    ),
  );
  rows.push(
    row(
      `${keyPrefix}-fits`,
      `   ${deterministic.taskFitCounts.fits} fit · ${deterministic.taskFitCounts.tight} tight · ${deterministic.taskFitCounts.overflow} overflow · ${deterministic.taskFitCounts.unknown} unknown (${deterministic.taskCount} tasks)`,
      'textDim',
    ),
  );
  rows.push(
    row(
      `${keyPrefix}-context`,
      `   Context explicit ${deterministic.contextConfidenceCounts.contextExplicit} · catalog ${deterministic.contextConfidenceCounts.contextKnownCatalog} · cached ${deterministic.contextConfidenceCounts.contextCachedProvider} · fallback ${deterministic.contextConfidenceCounts.contextConservativeFallback}`,
      'textDim',
    ),
  );
  rows.push(
    row(
      `${keyPrefix}-price`,
      `   Price known ${deterministic.priceConfidenceCounts.priceKnown} · unknown ${deterministic.priceConfidenceCounts.priceUnknown} · profile n/a ${deterministic.priceConfidenceCounts.profileUnavailable}`,
      'textDim',
    ),
  );
  if (unknownReasons) rows.push(row(`${keyPrefix}-unknown`, `   ${unknownReasons}`, 'warning'));
  rows.push(
    row(
      `${keyPrefix}-tools`,
      `   Planner: ${getProviderDisplayName(prediction.plannerTool)} Implementer: ${getProviderDisplayName(prediction.implementerTool)}`,
      'textDim',
    ),
  );
  if (reviewLine)
    rows.push(
      row(
        `${keyPrefix}-review`,
        `   ${reviewLine}`,
        prediction.plannerEstimateReview?.status === 'unavailable' ? 'warning' : 'planner',
      ),
    );
  return wrapRows(rows, width);
}

function formatNullableCost(cost: number | null): string {
  return cost === null ? 'n/a' : formatCost(cost);
}
