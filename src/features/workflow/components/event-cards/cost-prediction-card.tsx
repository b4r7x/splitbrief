import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { formatCost } from '../../../../core/formatting.js';
import { getProviderDisplayName } from '../../../../core/providers/catalog.js';
import {
  formatCostPredictionUnknownReasons,
  hasDisplayableCostPrediction,
  plannerEstimateReviewLine,
} from '../../../../core/layout/cost-chrome.js';

type CostPredictionEvent = Extract<EngineEvent, { type: 'cost_prediction' }>;

function formatNullableCost(cost: number | null): string {
  return cost === null ? 'n/a' : formatCost(cost);
}

export function CostPredictionCard({ event }: { event: CostPredictionEvent }) {
  const t = useTheme();
  const deterministic = event.prediction.deterministic;
  const hasPrediction = hasDisplayableCostPrediction(event.prediction);
  const reviewLine = plannerEstimateReviewLine(event.prediction);

  if (!hasPrediction) {
    return (
      <Box>
        <Text color={t.textDim}>prediction n/a</Text>
      </Box>
    );
  }

  if (deterministic) {
    const unknownReasons = formatCostPredictionUnknownReasons(deterministic.totals.unknownCostReason);
    return (
      <Box flexDirection="column">
        <Text color={t.accent} bold>
          Cost prediction
        </Text>
        <Text color={t.textDim}>Deterministic estimate from task briefs and routing preview</Text>
        <Box marginLeft={3}>
          <Text color={t.implementer}>Implementer: {formatNullableCost(deterministic.totals.knownActualEstimate)}</Text>
          <Text color={t.textDim}> </Text>
          <Text color={t.planner}>All planner: {formatNullableCost(deterministic.totals.hypotheticalAllPlanner)}</Text>
          <Text color={t.textDim}> </Text>
          <Text color={t.success}>Savings: {formatNullableCost(deterministic.totals.estimatedSavings)}</Text>
        </Box>
        <Box marginLeft={3}>
          <Text color={t.success}>{deterministic.taskFitCounts.fits} fit</Text>
          <Text color={t.textDim}> · </Text>
          <Text color={t.warning}>{deterministic.taskFitCounts.tight} tight</Text>
          <Text color={t.textDim}> · </Text>
          <Text color={t.error}>{deterministic.taskFitCounts.overflow} overflow</Text>
          <Text color={t.textDim}> · {deterministic.taskFitCounts.unknown} unknown ({deterministic.taskCount} tasks)</Text>
        </Box>
        <Box marginLeft={3}>
          <Text color={t.textDim}>
            Context explicit {deterministic.contextConfidenceCounts.contextExplicit} · catalog {deterministic.contextConfidenceCounts.contextKnownCatalog} · cached {deterministic.contextConfidenceCounts.contextCachedProvider} · fallback {deterministic.contextConfidenceCounts.contextConservativeFallback}
          </Text>
        </Box>
        <Box marginLeft={3}>
          <Text color={t.textDim}>
            Price known {deterministic.priceConfidenceCounts.priceKnown} · unknown {deterministic.priceConfidenceCounts.priceUnknown} · profile n/a {deterministic.priceConfidenceCounts.profileUnavailable}
          </Text>
        </Box>
        {unknownReasons && (
          <Box marginLeft={3}>
            <Text color={t.warning}>{unknownReasons}</Text>
          </Box>
        )}
        <Box marginLeft={3}>
          <Text color={t.textDim}>Planner: </Text>
          <Text color={t.planner}>{getProviderDisplayName(event.prediction.plannerTool)}</Text>
          <Text color={t.textDim}> Implementer: </Text>
          <Text color={t.implementer}>{getProviderDisplayName(event.prediction.implementerTool)}</Text>
        </Box>
        {reviewLine && (
          <Box marginLeft={3}>
            <Text color={event.prediction.plannerEstimateReview?.status === 'unavailable' ? t.warning : t.planner}>{reviewLine}</Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={t.accent} bold>
        Cost prediction
      </Text>
      <Text color={t.textDim}>Low: all local · Expected: ~15% escalation · High: ~40% escalation</Text>
      <Box marginLeft={3}>
        <Text color={t.success}>Low: {formatCost(event.prediction.lowCost)}</Text>
        <Text color={t.textDim}> (all local) </Text>
        <Text color={t.warning}>Expected: {formatCost(event.prediction.expectedCost)}</Text>
        <Text color={t.textDim}> </Text>
        <Text color={t.error}>High: {formatCost(event.prediction.highCost)}</Text>
      </Box>
      <Box marginLeft={3}>
        <Text color={t.textDim}>Planner: </Text>
        <Text color={t.planner}>{getProviderDisplayName(event.prediction.plannerTool)}</Text>
        <Text color={t.textDim}> Implementer: </Text>
        <Text color={t.implementer}>{getProviderDisplayName(event.prediction.implementerTool)}</Text>
        <Text color={t.textDim}> ({event.prediction.estimatedTasks} tasks)</Text>
      </Box>
      {reviewLine && (
        <Box marginLeft={3}>
          <Text color={event.prediction.plannerEstimateReview?.status === 'unavailable' ? t.warning : t.planner}>{reviewLine}</Text>
        </Box>
      )}
    </Box>
  );
}
