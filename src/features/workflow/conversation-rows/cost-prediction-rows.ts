import { formatCost } from '../../../core/formatting.js';
import {
  formatCostPredictionUnknownReasons,
  hasDisplayableCostPrediction,
  plannerEstimateReviewLine,
} from '../layout/cost-chrome.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { countNoun } from '../../../utils/pluralize.js';
import type { ConversationRow } from './types.js';
import { row, wrapRows } from './row-format/rows.js';

export function costPredictionRows(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'cost_prediction' }>,
  width: number,
): ConversationRow[] {
  const prediction = event.prediction;
  if (!hasDisplayableCostPrediction(prediction)) {
    return [];
  }

  const deterministic = prediction.deterministic;
  const reviewLine = plannerEstimateReviewLine(prediction);
  const rows: ConversationRow[] = [
    row({ key: `${keyPrefix}-title`, text: 'Cost prediction', tone: 'text', bold: true }),
  ];

  if (!deterministic) {
    rows.push(
      row({
        key: `${keyPrefix}-heuristic`,
        text: 'Low: all local · Expected: ~15% escalation · High: ~40% escalation',
        tone: 'textDim',
      }),
    );
    rows.push(
      row({
        key: `${keyPrefix}-costs`,
        text: `Low: ${formatCost(prediction.lowCost)} (all local) Expected: ${formatCost(prediction.expectedCost)} High: ${formatCost(prediction.highCost)}`,
        tone: 'textDim',
      }),
    );
    rows.push(
      row({
        key: `${keyPrefix}-tools`,
        text: `Planner: ${getProviderDisplayName(prediction.plannerTool)} Implementer: ${getProviderDisplayName(prediction.implementerTool)} (${countNoun(prediction.estimatedTasks, 'task')})`,
        tone: 'textDim',
      }),
    );
    if (reviewLine)
      rows.push(
        row({
          key: `${keyPrefix}-review`,
          text: reviewLine,
          tone: 'textDim',
        }),
      );
    const recommendation = prediction.plannerEstimateReview?.recommendedUserDecision;
    if (recommendation)
      rows.push(
        row({
          key: `${keyPrefix}-recommendation`,
          text: `Recommended: ${recommendation}`,
          tone: 'textDim',
        }),
      );
    return wrapRows(rows, width);
  }

  rows.push(
    row({
      key: `${keyPrefix}-desc`,
      text:
        deterministic.estimateScope === 'prompt-input-only'
          ? 'Deterministic estimate from task briefs and routing preview: prompt input only'
          : 'Deterministic estimate from task briefs and routing preview',
      tone: 'textDim',
    }),
  );
  const totalsLine = formatDeterministicTotals(deterministic);
  if (totalsLine) rows.push(row({ key: `${keyPrefix}-totals`, text: totalsLine, tone: 'textDim' }));
  const riskLine = formatDeterministicRiskCounts(deterministic);
  if (riskLine) rows.push(row({ key: `${keyPrefix}-risk`, text: riskLine, tone: 'textDim' }));
  const unknownReasons = formatBlockedUnknownReasons(deterministic);
  if (unknownReasons)
    rows.push(row({ key: `${keyPrefix}-unknown`, text: unknownReasons, tone: 'textDim' }));
  rows.push(
    row({
      key: `${keyPrefix}-tools`,
      text: `Planner: ${getProviderDisplayName(prediction.plannerTool)} Implementer: ${getProviderDisplayName(prediction.implementerTool)}`,
      tone: 'textDim',
    }),
  );
  if (reviewLine)
    rows.push(
      row({
        key: `${keyPrefix}-review`,
        text: reviewLine,
        tone: 'textDim',
      }),
    );
  const recommendation = prediction.plannerEstimateReview?.recommendedUserDecision;
  if (recommendation)
    rows.push(
      row({
        key: `${keyPrefix}-recommendation`,
        text: `Recommended: ${recommendation}`,
        tone: 'textDim',
      }),
    );
  return wrapRows(rows, width);
}

type DeterministicPrediction = NonNullable<
  Extract<EngineEvent, { type: 'cost_prediction' }>['prediction']['deterministic']
>;

function formatDeterministicTotals(deterministic: DeterministicPrediction): string {
  const totals = deterministic.totals;
  const promptLabel =
    deterministic.estimateScope === 'prompt-input-only' ? 'Prompt input' : 'Implementer';
  const parts: string[] = [];
  if (totals.knownActualEstimate !== null) {
    parts.push(`${promptLabel}: ${formatCost(totals.knownActualEstimate)}`);
  }
  if (totals.hypotheticalAllPlanner !== null) {
    parts.push(
      `${deterministic.estimateScope === 'prompt-input-only' ? 'All-planner prompt' : 'All planner'}: ${formatCost(totals.hypotheticalAllPlanner)}`,
    );
  }
  if (totals.estimatedSavings !== null) {
    parts.push(
      `${deterministic.estimateScope === 'prompt-input-only' ? 'Prompt saving' : 'Savings'}: ${formatCost(totals.estimatedSavings)}`,
    );
  }
  return parts.join(' ');
}

function formatDeterministicRiskCounts(deterministic: DeterministicPrediction): string {
  const parts: string[] = [];
  const { taskFitCounts, contextConfidenceCounts, priceConfidenceCounts } = deterministic;
  if (taskFitCounts.tight > 0) parts.push(`${taskFitCounts.tight} tight`);
  if (taskFitCounts.overflow > 0) parts.push(`${taskFitCounts.overflow} overflow`);
  if (taskFitCounts.unknown > 0) parts.push(`${taskFitCounts.unknown} context unknown`);
  if (contextConfidenceCounts.contextConservativeFallback > 0) {
    parts.push(`${contextConfidenceCounts.contextConservativeFallback} context fallback`);
  }
  if (contextConfidenceCounts.profileUnavailable > 0) {
    parts.push(`${contextConfidenceCounts.profileUnavailable} profile unavailable`);
  }
  if (priceConfidenceCounts.priceUnknown > 0) {
    parts.push(`${priceConfidenceCounts.priceUnknown} price unknown`);
  }
  if (priceConfidenceCounts.profileUnavailable > 0) {
    parts.push(`${priceConfidenceCounts.profileUnavailable} price profile n/a`);
  }
  if (parts.length === 0) return '';
  return `Risk: ${parts.join(' · ')} (${countNoun(deterministic.taskCount, 'task')})`;
}

function formatBlockedUnknownReasons(deterministic: DeterministicPrediction): string {
  const totals = deterministic.totals;
  if (totals.knownActualEstimate !== null && totals.hypotheticalAllPlanner !== null) return '';
  return formatCostPredictionUnknownReasons(totals.unknownCostReason);
}
