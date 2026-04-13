import { Box, Text } from 'ink';
import { formatEta } from '../../utils/format.js';
import { useTheme } from '../../ui/theme.js';
import { useCostStats, formatCostDisplay } from '../../hooks/use-cost-stats.js';

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

  const color = rateColor(localRate, t);
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const { localRatePct, showSavings, savingsText, hasPricedUsage, spentText } = formatCostDisplay(localRate, costBreakdown);
  const showSpent = hasPricedUsage && !showSavings;

  return (
    <Box width="100%" paddingX={1}>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}{etaText ? ` · ${etaText}` : ''}</Text>
        <Text color={color}>Local: {localRatePct}</Text>
        {showSavings && (
          <Text color={t.success}>Saved: {savingsText}</Text>
        )}
        {showSpent && (
          <Text color={t.textDim}>Spent: {spentText}</Text>
        )}
      </Box>
    </Box>
  );
}
