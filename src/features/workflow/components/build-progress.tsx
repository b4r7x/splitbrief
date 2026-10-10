import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { useSharedClock } from '../../../hooks/use-shared-clock.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useStores } from '../../../stores/use-stores.js';
import { buildProgressRows, deriveBuildProgress } from '../display/build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export function BuildProgressBlock({ cols }: { cols: number }) {
  const t = useTheme();
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
      {lines.map(({ key, text, silenceStart }, index) => {
        // Freshness closes the last row at every width. A silence takes the warning colour the
        // byline's stall lead wears, cut or whole; the facts that share its row keep theirs.
        const start = silenceStart ?? text.length;
        const silence = silenceStart !== null && text.length > start;
        return (
          <Text key={key} color={index === 0 ? t.text : t.textDim} wrap="truncate">
            {silence ? text.slice(0, start) : text}
            {silence && <Text color={t.warning}>{text.slice(start)}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
