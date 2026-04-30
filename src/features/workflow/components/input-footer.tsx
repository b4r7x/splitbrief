import { Box, Text } from 'ink';
import { useSyncExternalStore } from 'react';
import { useTheme } from '../../../components/theme.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { CostDisplay } from './cost/display.js';
import { computeEta } from './cost/footer.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { useStores } from '../../../stores/use-stores.js';
import {
  formatAdvisoryText,
  getAdvisory,
  subscribeAdvisory,
} from '../../../engine/orchestrator/planning/mode-advisor.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';

export function InputFooter() {
  const t = useTheme();
  const [{ scrollOffset }, { queueDepth }] = useStores(conversationScrollStore, lifecycleStore);
  const isAttachedClient = routerStore.use(s => s.screen === 'workflow' && s.attach !== undefined);
  const { currentTask, totalTasks, taskCompletionTimes } = useCostStats();
  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const advisory = useSyncExternalStore(subscribeAdvisory, getAdvisory, getAdvisory);
  const workflow = configStore.useConfig().workflow;
  const commitStrategy = workflow.git?.commitStrategy ?? workflow.commitStrategy ?? 'none';
  const createBranchEnabled = workflow.git?.createBranch ?? false;
  const gitLabel = createBranchEnabled
    ? `git: branch+${commitStrategy}`
    : `git: ${commitStrategy}`;

  return (
    <Box width="100%" paddingX={1} justifyContent="space-between" height={1} flexShrink={0}>
      <Box gap={1}>
        {isAttachedClient ? (
          <Text color={t.textDim}>^D detach</Text>
        ) : (
          <>
            <Text color={t.textDim}>^C abort</Text>
            <Text color={t.textDim}>^C^C exit</Text>
          </>
        )}
        {advisory !== null && advisory.kind !== 'none' && (
          <Text color={t.warning}>{formatAdvisoryText(advisory)}</Text>
        )}
      </Box>
      <Box gap={2}>
        <Text color={t.text}>Task {currentTask}/{totalTasks}{etaText ? ` · ${etaText}` : ''}</Text>
        {queueDepth > 0 && <Text color={t.info}>queue: {queueDepth}</Text>}
        <Text color={t.textDim}>{gitLabel}</Text>
        {scrollOffset > 0 ? (
          <Text color={t.textDim}>G to bottom</Text>
        ) : (
          <CostDisplay spentHiddenWhenSavings useRateColor />
        )}
      </Box>
    </Box>
  );
}
