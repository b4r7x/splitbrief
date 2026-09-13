import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { useStores } from '../../../stores/use-stores.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { buildProgressLines, deriveBuildProgress } from '../display/build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export function BuildProgressBlock({ cols }: { cols: number }) {
  const t = useTheme();
  const [tasks, tokens, lifecycle, operations] = useStores(
    tasksStore,
    tokensStore,
    lifecycleStore,
    operationsStore,
  );
  const config = configStore.use((state) => state.config);
  const width = getChromeContentWidth(cols);
  const progress = deriveBuildProgress({
    tasks,
    tokens,
    lifecycle,
    operations,
    config,
    now: Date.now(),
  });
  return (
    <Box flexDirection="column" flexShrink={0}>
      {buildProgressLines(progress, width).map((line, index) => (
        <Text key={line} color={index === 0 ? t.text : t.textDim} wrap="truncate">
          {truncateTerminalDisplayText(line, width)}
        </Text>
      ))}
    </Box>
  );
}
