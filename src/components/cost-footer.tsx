import { Box, Text } from 'ink';
import { formatCost } from '../utils/format.js';
import { useTheme } from '../ui/theme.js';

interface CostFooterProps {
  currentTask: number;
  totalTasks: number;
  localRate: number;
  estimatedCost: number;
  estimatedSavings: number;
  implementerModel: string;
  isSmall?: boolean;
}

export default function CostFooter({ currentTask, totalTasks, localRate, estimatedCost, estimatedSavings, implementerModel, isSmall }: CostFooterProps) {
  const t = useTheme();
  const color = localRate >= 50 ? t.success : localRate >= 25 ? t.warning : t.error;

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}</Text>
        <Text color={color}>Local: {Math.round(localRate)}%</Text>
        {!isSmall && (
          <>
            <Text color={t.text}>{formatCost(estimatedCost)}</Text>
            <Text color={t.success}>Saved: ~{formatCost(estimatedSavings)}</Text>
          </>
        )}
        <Text color={t.textDim}>{implementerModel}</Text>
      </Box>
    </Box>
  );
}
