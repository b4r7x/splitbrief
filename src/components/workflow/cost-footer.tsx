import { Box, Text } from 'ink';
import { formatCost, formatEta } from '../../utils/format.js';
import { useTheme } from '../../ui/theme.js';
import { useCostStats } from '../../hooks/use-cost-stats.js';

function rateColor(rate: number, t: { success: string; warning: string; error: string }): string {
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

export function computeEta(taskCompletionTimes: number[], currentTask: number, totalTasks: number): string {
  if (taskCompletionTimes.length === 0) return '';
  const remainingTasks = totalTasks - currentTask;
  if (remainingTasks <= 0) return '';
  const avgTime = taskCompletionTimes.reduce((a, b) => a + b, 0) / taskCompletionTimes.length;
  return formatEta(avgTime * remainingTasks);
}

export function CostFooter() {
  const t = useTheme();
  const { localRate, costBreakdown, currentTask, totalTasks, taskCompletionTimes } = useCostStats();

  const estimatedSavings = costBreakdown?.savingsAmount ?? 0;
  const color = rateColor(localRate, t);
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);

  return (
    <Box width="100%" paddingX={1}>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}{etaText ? ` · ${etaText}` : ''}</Text>
        <Text color={color}>Local: {Math.round(localRate)}%</Text>
        <Text color={t.success}>Saved: ~{formatCost(estimatedSavings)}</Text>
      </Box>
    </Box>
  );
}
