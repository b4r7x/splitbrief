import { Box } from 'ink';
import { Divider } from '../../../../components/divider.js';
import { TextSpans } from '../../../../components/text-spans.js';
import { useTheme, ThemeText as Text } from '../../../../components/theme.js';
import { CREW_LABEL_WIDTH, formatSeatIdentity } from '../../../../core/crew/identity.js';
import { wrapSeatIdentity, cutSeatIdentity } from '../../../../core/crew/seat-line/wrap.js';
import {
  type CrewSeat,
  deriveCrewSeats,
  crewSeatWord,
  CREW_SEAT_ROLES,
} from '../../../../core/crew/seats.js';
import { selectTaskListView } from '../../../../core/run-view/briefs.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { useCrewDisplayNames } from '../../../../hooks/use-crew-display-names.js';
import { borderStyleFor } from '../../../../lib/glyphs.js';
import { configStore } from '../../../../stores/project/config.js';
import { runViewStore } from '../../../../stores/workflow/run-view.js';
import { tokensStore } from '../../../../stores/workflow/tokens/state.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { segmentsForRowText, getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { wrapHard } from '../../../../utils/display-text/wrap.js';
import { seatIdentityPieces } from '../../closed/copy/crew-line.js';
import type { RecordedCrew } from '../../closed/view-model.js';
import { taskOutcomeCountsSpans, passedCountSpans } from '../../display/build-progress/counts.js';
import { resolvedSeatModel } from '../../display/running-seats.js';
import { useRunningSeats } from '../../hooks/use-running-seats.js';
import {
  getSidebarFooterBudget,
  getSidebarTaskListRows,
  getSidebarTaskWindow,
  getSidebarStatusColumnCells,
} from '../../layout/rect.js';
import {
  packPieces,
  anchorIndex,
  overflowLabel,
  combinedOverflowLabel,
  taskHasStatusTail,
  LIST_INDENT,
} from '../../layout/sidebar-view.js';
import { TaskRow } from './task-row.js';

interface SidebarProps {
  width: number;
  height?: number | undefined;
  /** The crew the run's record names (`recordedCrew`); without it the crew is today's. */
  recordedCrew?: RecordedCrew | undefined;
}

interface SeatRows {
  seat: CrewSeat;
  rows: string[];
}

export function Sidebar({ width, height, recordedCrew }: SidebarProps) {
  const tooShortForBorder = height !== undefined && height < 2;
  const t = useTheme();
  const view = selectTaskListView(runViewStore.use((s) => s.briefs));
  const config = configStore.use((s) => s.config);
  const running = useRunningSeats();
  const resolvedModels = tokensStore.use((s) => s.resolvedModels);
  const displayNames = useCrewDisplayNames(config);
  const seats: readonly CrewSeat[] = config ? deriveCrewSeats({ config, displayNames }) : [];
  const tasks = view.items;
  const innerWidth = Math.max(0, width - 4);
  const outcomeSpans = taskOutcomeCountsSpans(passedCountSpans(`${view.passed}`), view);
  const outcomeText = outcomeSpans.map((part) => part.text).join('');
  const outcomeRows =
    view.escalated > 0 || view.failed > 0 ? wrapHard(outcomeText, innerWidth).split('\n') : [];
  let outcomeOffset = 0;
  const outcomeRowSpans = outcomeRows.map((row) => {
    const spans = segmentsForRowText(outcomeSpans, row, outcomeOffset);
    outcomeOffset += row.length;
    return spans;
  });
  const identityWidth = innerWidth - CREW_LABEL_WIDTH;
  const crewRows = (
    toRows: (
      pieces: readonly string[],
      /** The model id the seat's call ran, when its saved value does not name it. */
      resolved?: string | undefined,
    ) => string[],
  ): SeatRows[] =>
    seats.map((seat) => {
      const runningSeat = running[seat.id];
      return {
        seat,
        rows:
          recordedCrew !== undefined
            ? toRows(seatIdentityPieces(recordedCrew[seat.id]))
            : runningSeat !== undefined
              ? toRows(
                  [formatSeatIdentity(runningSeat)],
                  resolvedSeatModel(runningSeat.seat, resolvedModels[seat.id]),
                )
              : seat.id === 'review' && seat.source !== 'configured'
                ? [crewSeatWord(seat)]
                : toRows(
                    [
                      formatSeatIdentity({
                        seat: seat.runner,
                        displayName: displayNames?.[seat.id],
                      }),
                    ],
                    resolvedSeatModel(seat.runner, resolvedModels[seat.id]),
                  ),
      };
    });
  const countFooterRows = (crew: readonly SeatRows[]): number =>
    crew.reduce((total, { rows }) => total + rows.length, outcomeRows.length);
  const fits = (crew: readonly SeatRows[]): boolean =>
    height === undefined || countFooterRows(crew) <= getSidebarFooterBudget({ height });
  const wrapRows = (pieces: readonly string[]): string[] =>
    pieces.length === 1
      ? wrapSeatIdentity(pieces.join(''), identityWidth)
      : packPieces(pieces, identityWidth);
  const resolvedSeatRows = crewRows((pieces, resolved) => [
    ...wrapRows(pieces),
    ...(resolved === undefined ? [] : [cutSeatIdentity(resolved, identityWidth)]),
  ]);
  const wrappedSeatRows = fits(resolvedSeatRows) ? resolvedSeatRows : crewRows(wrapRows);
  // With the list already at zero rows, a crew that overruns the bottom border first gives up the
  // resolved model rows, then gives each seat the one row its cut identity takes.
  const seatRows = fits(wrappedSeatRows)
    ? wrappedSeatRows
    : crewRows((pieces) => [cutSeatIdentity(pieces.join(' '), identityWidth)]);

  const footerRows = countFooterRows(seatRows);
  // Without a height the caller is not budgeting rows, so the list never windows.
  const listRows =
    height === undefined ? tasks.length : getSidebarTaskListRows({ height, footerRows });
  const windowInput = { itemCount: tasks.length, anchorIndex: anchorIndex(tasks) };
  const fullWindow = getSidebarTaskWindow({ ...windowInput, rows: listRows });
  // The queued count shares the row the "N below" marker already claims, so it costs a row of its
  // own only when nothing is scrolled off the bottom.
  const listWindow =
    height !== undefined && view.unannounced > 0 && fullWindow.hiddenBelow === 0
      ? getSidebarTaskWindow({ ...windowInput, rows: Math.max(0, listRows - 1) })
      : fullWindow;
  const visible = tasks.slice(listWindow.start, listWindow.end);
  const hiddenAbove = tasks.slice(0, listWindow.start);
  const hiddenBelow = tasks.slice(listWindow.end);
  const aboveLabel = overflowLabel(hiddenAbove, 'done', 'done', 'above');
  const belowLabel = overflowLabel(hiddenBelow, 'pending', 'queued', 'below');
  const tail = [
    listWindow.combine ? combinedOverflowLabel(aboveLabel, belowLabel, width) : '',
    listWindow.showBelow ? belowLabel : '',
    view.unannounced > 0 ? `+${view.unannounced} more` : '',
  ].filter((part) => part !== '');
  const statusCells = getSidebarStatusColumnCells({
    hasStatusTail: tasks.some(taskHasStatusTail),
  });

  // Ink's border consumes two rows even when a smaller explicit height is supplied. At the
  // terminal's unusable 0–1 row sizes, omit the panel rather than letting its border escape the
  // body viewport; the parent will render it again as soon as a two-row panel can fit.
  if (tooShortForBorder) return null;

  const title = truncateTerminalDisplayText(
    view.total === 0 ? 'Tasks' : `Tasks ${view.passed}/${view.total}`,
    innerWidth,
  );

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
        {tasks.length === 0 && <Text color={t.textDim}>{`${LIST_INDENT}No tasks yet`}</Text>}
        {listWindow.showAbove && <Text color={t.textDim}>{`${LIST_INDENT}${aboveLabel}`}</Text>}
        {visible.map((task) => (
          <TaskRow key={task.id} task={task} width={width} statusCells={statusCells} />
        ))}
        {tail.length > 0 && <Text color={t.textDim}>{`${LIST_INDENT}${tail.join(SOFT_SEP)}`}</Text>}
      </Box>

      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        <Box paddingX={1} flexShrink={0}>
          <Divider width={innerWidth} />
        </Box>
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          {outcomeRowSpans.map((spans, index) => (
            <Text key={index}>
              <TextSpans parts={spans} />
            </Text>
          ))}
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
