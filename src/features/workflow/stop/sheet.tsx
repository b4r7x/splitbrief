import { plainUserMessage } from '../../../core/types/user-input.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box, useInput } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { listRowLead } from '../../../components/list-row.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  cancelBoundaryPause,
  requestBoundaryPause,
  requestEndRun,
  requestStopNow,
  requestResume,
  requestLeaveSession,
} from '../handlers.js';
import {
  STOP_SHEET_FOOTER,
  STOP_SHEET_LEGEND,
  STOP_SHEET_PARKED_LEGEND,
  STOP_SHEET_TITLE,
  stopMenuLayout,
  type StopRow,
  type StopRowId,
} from './options.js';

function performStop(id: StopRowId): void {
  switch (id) {
    case 'resume':
      requestResume(plainUserMessage(''));
      return;
    case 'leave':
      requestLeaveSession();
      return;
    case 'retry-stop':
    case 'stop-now':
      requestStopNow();
      return;
    case 'pause-after-brief':
      requestBoundaryPause();
      return;
    case 'keep-running':
      cancelBoundaryPause();
      return;
    case 'end-run':
      requestEndRun();
      return;
    default:
      assertNever(id);
  }
}

export function StopSheet({
  rows,
  height,
  footer = STOP_SHEET_FOOTER,
}: {
  rows: readonly StopRow[];
  height?: number | undefined;
  footer?: string | undefined;
}) {
  const t = useTheme();
  const cols = terminalSizeStore.use((state) => state.cols);
  const layout = stopMenuLayout(rows, cols);
  const legend = fitKeyLegend(
    rows.some((row) => row.id === 'leave') ? STOP_SHEET_PARKED_LEGEND : STOP_SHEET_LEGEND,
    Math.max(1, layout.width - 4),
  );

  const { selectedIndex } = useStaticSelector<StopRow>({
    items: rows,
    // The run keeps going behind the sheet and the middle row comes and goes with the running
    // brief, so the cursor is pinned to its row id rather than to a slot End run can slide into.
    keyOf: (row) => row.id,
    onSelect: (row) => {
      overlayStore.close();
      performStop(row.id);
    },
  });
  // Escape belongs to the app's stop ladder; Tab only dismisses this menu.
  useInput((_input, key) => {
    if (key.tab) overlayStore.close();
  });

  return (
    <Box
      width={layout.width}
      height={height ?? layout.height}
      borderStyle={borderStyleFor('single')}
      borderColor={t.accent}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
    >
      <Text color={t.textDim} wrap="truncate-end">
        {fitKeyLegend(
          `${rows.some((row) => row.id === 'leave') ? 'Session options' : STOP_SHEET_TITLE} · ${footer}`,
          Math.max(1, layout.width - 4),
        )}
      </Text>
      <Box height={layout.bodyRows} flexDirection="column" flexShrink={0}>
        {layout.options.map(({ row, lines }, index) => (
          <Box key={row.id} flexDirection="column">
            {lines.map((line, lineIndex) => (
              <Text key={lineIndex} color={index === selectedIndex ? t.accent : t.text}>
                {listRowLead(index === selectedIndex && lineIndex === 0 ? 'active' : 'default')}
                {line}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text color={t.textDim}>{legend}</Text>
    </Box>
  );
}
