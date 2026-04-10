import { Box, Text } from 'ink';
import { formatCost } from '../../utils/format.js';
import { useTheme } from '../../ui/theme.js';
import { useCostStats } from '../../hooks/use-cost-stats.js';

function rateColor(rate: number, t: { success: string; warning: string; error: string }): string {
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

export function CostFooter() {
  const t = useTheme();
  const { localRate, costBreakdown, currentTask, totalTasks } = useCostStats();

  const estimatedSavings = costBreakdown?.savingsAmount ?? 0;
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
