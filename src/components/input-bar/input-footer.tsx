import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { useCostStats } from '../workflow/use-cost-stats.js';
import { conversationScrollStore } from '../../stores/conversation-scroll.js';
import { CostDisplay } from '../workflow/cost-display.js';
import { computeEta } from '../workflow/cost-footer.js';
import { workflowStore } from '../../stores/workflow.js';
import { useStores } from '../../stores/use-stores.js';

export function InputFooter() {
  const t = useTheme();
  const [{ scrollOffset }, { queueDepth }] = useStores(conversationScrollStore, workflowStore);
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
