import { Box } from 'ink';
import { Divider } from '../../../../components/divider.js';
import { useTheme, ThemeText as Text } from '../../../../components/theme.js';
import { CREW_LABEL_WIDTH } from '../../../../core/crew/identity.js';
import { deriveCrewSeats, CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { selectTaskListView } from '../../../../core/run-view/briefs.js';
import { useCrewDisplayNames } from '../../../../hooks/use-crew-display-names.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { configStore } from '../../../../stores/project/config.js';
import { runViewStore } from '../../../../stores/workflow/run-view.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import type { RecordedCrew } from '../../closed/view-model.js';
import { useRunningSeats } from '../../hooks/use-running-seats.js';
import { deriveSidebarView, LIST_INDENT } from '../../layout/sidebar-view.js';
import { TaskRow } from './task-row.js';

interface SidebarProps {
  width: number;
  height?: number | undefined;
  /** The crew the run's record names (`recordedCrew`); without it the crew is today's. */
  recordedCrew?: RecordedCrew | undefined;
}

export function Sidebar({ width, height, recordedCrew }: SidebarProps) {
  const t = useTheme();
  const view = selectTaskListView(runViewStore.use((s) => s.briefs));
  const config = configStore.use((s) => s.config);
  const running = useRunningSeats();
  const resolvedModels = runViewStore.use((s) => s.resolvedModels);
  const displayNames = useCrewDisplayNames(config);

  // Ink's border consumes two rows even when a smaller explicit height is supplied. At the
  // terminal's unusable 0–1 row sizes, omit the panel rather than letting its border escape the
  // body viewport; the parent will render it again as soon as a two-row panel can fit.
  if (height !== undefined && height < 2) return null;

  const { title, innerWidth, visible, aboveLabel, tailLabel, seatRows } = deriveSidebarView({
    view,
    seats: config ? deriveCrewSeats({ config, displayNames }) : [],
    displayNames,
    running,
    resolvedModels,
    recordedCrew,
    width,
    height,
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
    >
      <Box position="absolute" marginTop={-1} width={getTerminalCellWidth(title) + 2}>
        <Text color={t.textDim} wrap="truncate">
          {` ${title} `}
        </Text>
      </Box>
      <Box flexDirection="column" paddingRight={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {view.items.length === 0 && <Text color={t.textDim}>{`${LIST_INDENT}No briefs yet`}</Text>}
        {aboveLabel !== undefined && <Text color={t.textDim}>{`${LIST_INDENT}${aboveLabel}`}</Text>}
        {visible.map((task) => (
          <TaskRow key={task.id} task={task} width={width} />
        ))}
        {tailLabel !== undefined && <Text color={t.textDim}>{`${LIST_INDENT}${tailLabel}`}</Text>}
      </Box>

      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        <Box paddingX={1} flexShrink={0}>
          <Divider width={innerWidth} />
        </Box>
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          {seatRows.map(({ seat, rows }) => (
            <Box key={seat.id} flexDirection="column">
              {rows.map((row, index) => (
                <Text key={index} wrap="truncate">
                  <Text color={t[CREW_SEAT_ROLES[seat.id]]} bold>
                    {(index === 0 ? seat.label : '').padEnd(CREW_LABEL_WIDTH)}
                  </Text>
                  <Text color={t[CREW_SEAT_ROLES[seat.id]]}>{row}</Text>
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
