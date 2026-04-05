import { Box, Text } from 'ink';
import { formatCost } from '../utils/format.js';
import { useTheme } from '../ui/theme.js';

function rateColor(rate: number, t: { success: string; warning: string; error: string }): string {
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

interface CostFooterProps {
  currentTask: number;
  totalTasks: number;
  localRate: number;
  estimatedSavings: number;
}

export default function CostFooter({ currentTask, totalTasks, localRate, estimatedSavings }: CostFooterProps) {
  const t = useTheme();
  const color = rateColor(localRate, t);

  return (
    <Box width="100%" paddingX={1}>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}</Text>
        <Text color={color}>Local: {Math.round(localRate)}%</Text>
        <Text color={t.success}>Saved: ~{formatCost(estimatedSavings)}</Text>
      </Box>
    </Box>
  );
}
