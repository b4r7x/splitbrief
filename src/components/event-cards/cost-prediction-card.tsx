import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';
import { formatCost } from '../../utils/format.js';
import { getProviderDisplayName } from '../../core/providers.js';

type CostPredictionEvent = Extract<TuiEvent, { type: 'cost-prediction' }>;

export function CostPredictionCard({ event }: { event: CostPredictionEvent }) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={t.accent} bold>
        Cost Estimate
      </Text>
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
