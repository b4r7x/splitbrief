import { Box, Text } from 'ink';
import { formatEta } from '../../../utils/format-time.js';
import { useTheme } from '../../../components/theme.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { CostDisplay } from './cost-display.js';

export function computeEta(taskCompletionTimes: number[], currentTask: number, totalTasks: number): string {
  if (taskCompletionTimes.length === 0) return '';
  const remainingTasks = totalTasks - currentTask;
  if (remainingTasks <= 0) return '';
  const avgTime = taskCompletionTimes.reduce((a, b) => a + b, 0) / taskCompletionTimes.length;
  return formatEta(avgTime * remainingTasks);
}

export function CostFooter() {
  const t = useTheme();
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const queueDepth = lifecycleStore.use(s => s.queueDepth);
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);

  return (
    <Box width="100%" paddingX={1}>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}{etaText ? ` · ${etaText}` : ''}</Text>
        {queueDepth > 0 && <Text color={t.info}>queue: {queueDepth}</Text>}
        <CostDisplay spentHiddenWhenSavings useRateColor />
      </Box>
    </Box>
  );
}
