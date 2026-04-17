import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { useCostStats } from '../../features/workflow/hooks/use-cost-stats.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { CostDisplay } from '../../features/workflow/components/cost-display.js';
import { computeEta } from '../../features/workflow/components/cost-footer.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { useStores } from '../../stores/use-stores.js';

export function InputFooter() {
  const t = useTheme();
  const [{ scrollOffset }, { queueDepth }] = useStores(conversationScrollStore, lifecycleStore);
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between" height={1} flexShrink={0}>
      <Box gap={1}>
        <Text color={t.textDim}>^C abort</Text>
        <Text color={t.textDim}>^C^C exit</Text>
      </Box>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}{etaText ? ` · ${etaText}` : ''}</Text>
        {queueDepth > 0 && <Text color={t.info}>queue: {queueDepth}</Text>}
        {scrollOffset > 0 ? (
          <Text color={t.textDim}>G to bottom</Text>
        ) : (
          <CostDisplay spentHiddenWhenSavings useRateColor />
        )}
      </Box>
    </Box>
  );
}
