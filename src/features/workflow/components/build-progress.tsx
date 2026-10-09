import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { useSharedClock } from '../../../hooks/use-shared-clock.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useStores } from '../../../stores/use-stores.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { buildProgressLines, deriveBuildProgress } from '../display/build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { SOFT_SEP } from '../../../core/separators.js';

export function BuildProgressBlock({ cols }: { cols: number }) {
  const t = useTheme();
  const [tasks, lifecycle, operations] = useStores(tasksStore, lifecycleStore, operationsStore);
  const running = lifecycle.status === 'running';
  // Freshness counts the seconds since the seat last spoke, so it has to move while the seat says
  // nothing: the shared run clock repaints the block when nothing else does.
  const now = useSharedClock({ active: running });
  const width = getChromeContentWidth(cols);
  const progress = deriveBuildProgress({ tasks, lifecycle, operations, now });
  const lines = buildProgressLines(progress, width);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => {
        const text = truncateTerminalDisplayText(line, width);
        // Freshness closes the last row at every width. A silence takes the warning colour the
        // byline's stall lead wears, cut or whole; the facts that share its row keep theirs.
        // A silent row is cut only from its end, so the activity before it stays whole.
        const start = lines.length === 2 ? `${progress.activity}${SOFT_SEP}`.length : 0;
        const silence = progress.silent && index === lines.length - 1 && text.length > start;
        return (
          <Text key={line} color={index === 0 ? t.text : t.textDim} wrap="truncate">
            {silence ? text.slice(0, start) : text}
            {silence && <Text color={t.warning}>{text.slice(start)}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
