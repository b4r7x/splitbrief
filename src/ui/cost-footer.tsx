import { Box, Text } from 'ink';
import { formatCost } from '../utils/format.js';
import { getTheme } from '../theme.js';

interface CostFooterProps {
  currentTask: number;
  totalTasks: number;
  localRate: number;
  estimatedCost: number;
  estimatedSavings: number;
  implementerModel: string;
  isSmall?: boolean;
}

export function rateColor(localRate: number): string {
  const t = getTheme();
  if (localRate >= 50) return t.success;
  if (localRate >= 25) return t.warning;
  return t.error;
}

export default function CostFooter({ currentTask, totalTasks, localRate, estimatedCost, estimatedSavings, implementerModel, isSmall }: CostFooterProps) {
  const t = getTheme();
  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}</Text>
        <Text color={rateColor(localRate)}>Local: {Math.round(localRate)}%</Text>
        {!isSmall && (
          <>
            <Text color={t.text}>{formatCost(estimatedCost)}</Text>
            <Text color={t.success}>Saved: ~{formatCost(estimatedSavings)}</Text>
          </>
        )}
        <Text color={t.textDim}>{implementerModel}</Text>
      </Box>
      <Text color={t.textDim}>ctrl+b budget</Text>
    </Box>
  );
}
