import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { formatCost } from '../../../../core/formatting.js';
import { getProviderDisplayName } from '../../../../core/providers/catalog.js';

type CostPredictionEvent = Extract<EngineEvent, { type: 'cost_prediction' }>;

export function CostPredictionCard({ event }: { event: CostPredictionEvent }) {
  const t = useTheme();
  const hasPrediction = event.prediction.estimatedTasks > 0 || event.prediction.expectedCost > 0;

  if (!hasPrediction) {
    return (
      <Box>
        <Text color={t.textDim}>prediction n/a</Text>
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
    </Box>
  );
}
