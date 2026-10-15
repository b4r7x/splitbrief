import { ThemeText as Text } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import { Box } from 'ink';
import { useSharedClock } from '../../../hooks/use-shared-clock.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useStores } from '../../../stores/use-stores.js';
import { buildProgressRows, deriveBuildProgress } from '../display/build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export function BuildProgressBlock({ cols }: { cols: number }) {
  const [tasks, lifecycle, operations] = useStores(tasksStore, lifecycleStore, operationsStore);
  const running = lifecycle.status === 'running';
  // Freshness counts the seconds since the seat last spoke, so it has to move while the seat says
  // nothing: the shared run clock repaints the block when nothing else does.
  const now = useSharedClock({ active: running });
  const width = getChromeContentWidth(cols);
  const progress = deriveBuildProgress({ tasks, lifecycle, operations, now });
  const lines = buildProgressRows(progress, width);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map(({ key, spans }) => (
        <Text key={key} wrap="truncate">
          <TextSpans parts={spans} />
        </Text>
      ))}
    </Box>
  );
}
