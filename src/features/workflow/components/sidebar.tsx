import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { borderStyleFor, glyph, type GlyphName } from '../../../lib/glyphs.js';
import type { Theme } from '../../../core/theme/palette.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { type WorkflowTask, selectTaskListView } from '../../../core/run-view/briefs.js';
import { taskRowLabel } from '../../../core/run-view/brief-labels.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { configStore } from '../../../stores/project/config.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  CREW_LABEL_WIDTH,
  cutSeatIdentity,
  formatSeatIdentity,
  wrapSeatIdentity,
} from '../../../core/crew/identity.js';
import {
  CREW_SEAT_ROLES,
  crewSeatWord,
  deriveCrewSeats,
  type CrewSeat,
} from '../../../core/crew/seats.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import type { RailHalt } from '../../../core/rail-stages.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { routeBriefMark } from '../at-rest.js';
import { seatIdentityPieces } from '../closed/copy.js';
import type { RecordedCrew } from '../closed/view-model.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import {
  getSidebarFooterBudget,
  getSidebarTaskListRows,
  getSidebarTaskTitleWidth,
  getSidebarTaskWindow,
  getSidebarStatusColumnCells,
} from '../layout/rect.js';
import { Divider } from '../../../components/divider.js';
import { passedCountSpans, taskOutcomeCountsSpans } from '../display/build-progress.js';
import { useRunningSeats } from '../hooks/use-running-seats.js';
import { resolvedSeatModel } from '../display/running-seats.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { TextSpans } from '../../../components/text-spans.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';

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

interface RowSpec {
  bar: string;
  marker: string;
  markerColor: string | undefined;
  labelColor: string | undefined;
  bold: boolean;
  tail?: { text: string; color: string | undefined };
}

const TASK_STATUS_GLYPH_NAME: Record<WorkflowTask['status'], GlyphName> = {
  done: 'stageDone',
  failed: 'statusFailed',
  escalated: 'statusEscalated',
  in_progress: 'statusInProgress',
  pending: 'statusPending',
  skipped: 'statusSkipped',
};

// Bar, marker, and the space after it — the cells a task row paints before its title.
const LIST_INDENT = '   ';
// 2 border cells + the 1-cell right padding + the indent a marker row shares with the title column;
// the bar sits in the cell the left padding would take.
const SIDEBAR_MARKER_ROW_OVERHEAD = 3 + LIST_INDENT.length;

function statusGlyph(status: WorkflowTask['status']): string {
  return glyph(TASK_STATUS_GLYPH_NAME[status]);
}

function rowSpec(status: WorkflowTask['status'], t: Theme, restMark: RailHalt | null): RowSpec {
  switch (status) {
    case 'done':
      return {
        bar: ' ',
        marker: statusGlyph('done'),
        markerColor: t[stateTone('passed')],
        labelColor: t.textDim,
        bold: false,
      };
    case 'in_progress':
      return {
        bar: glyph('liveBar'),
        marker:
          restMark === null
            ? statusGlyph('in_progress')
            : glyph(restMark === 'failed' ? 'statusFailed' : 'statusCancelled'),
        markerColor:
          t[
            stateTone(
              restMark === null ? 'running' : restMark === 'failed' ? 'failed' : 'attention',
            )
          ],
        labelColor: t.text,
        bold: true,
      };
    case 'pending':
      return {
        bar: ' ',
        marker: statusGlyph('pending'),
        markerColor: t[stateTone('pending')],
        labelColor: t.textDim,
        bold: false,
      };
    case 'escalated':
      return {
        bar: ' ',
        marker: statusGlyph('escalated'),
        markerColor: t[stateTone('attention')],
        labelColor: t.text,
        bold: false,
        tail: { text: 'escalated', color: t[stateTone('attention')] },
      };
    case 'failed':
      return {
        bar: ' ',
        marker: statusGlyph('failed'),
        markerColor: t[stateTone('failed')],
        labelColor: t.text,
        bold: false,
        tail: { text: 'failed', color: t[stateTone('failed')] },
      };
    case 'skipped':
      return {
        bar: ' ',
        marker: statusGlyph('skipped'),
        markerColor: t.textDim,
        labelColor: t.textDim,
        bold: false,
        tail: { text: 'skipped', color: t.textDim },
      };
    default:
      return assertNever(status);
  }
}

function TaskRow({
  task,
  width,
  statusCells,
}: {
  task: WorkflowTask;
  width: number;
  statusCells: number;
}) {
  const t = useTheme();
  const restMark = routerStore.use(routeBriefMark);
  const spec = rowSpec(task.status, t, restMark);
  const titleCells = getSidebarTaskTitleWidth({ width, reservedTailCells: statusCells });
  const taskLabel = taskRowLabel(task, titleCells);
  return (
    <Box>
      <Text color={spec.labelColor} bold={spec.bold}>
        {spec.bar}
      </Text>
      <Text color={spec.markerColor} bold={spec.bold}>
        {spec.marker}{' '}
      </Text>
      <Box width={titleCells} flexShrink={0}>
        <Text color={spec.labelColor} bold={spec.bold}>
          {taskLabel}
        </Text>
      </Box>
      {spec.tail && <Text color={spec.tail.color}>{`  ${spec.tail.text}`}</Text>}
    </Box>
  );
}

// The running task anchors the window; once every task has settled the tail is the useful end.
function anchorIndex(tasks: readonly WorkflowTask[]): number {
  const running = tasks.findIndex((task) => task.status === 'in_progress');
  return running >= 0 ? running : Math.max(0, tasks.length - 1);
}

// The list follows the run rather than scrolling, so a bare count would be a dead end: it says work
// is out of view without saying what it is. Naming the state when the hidden slice is uniform tells
// the reader nothing actionable is hiding up there; a mixed slice falls back to the plain count.
function overflowLabel(
  hidden: readonly WorkflowTask[],
  status: WorkflowTask['status'],
  word: string,
  side: string,
): string {
  const named = hidden.length > 0 && hidden.every((task) => task.status === status);
  return `${hidden.length} ${named ? `${word} ` : ''}${side}`;
}

// One row has to carry both edges. When it cannot hold both in full the direction words go — never
// the status words, and never from one side only, because an asymmetric drop reads as the two edges
// meaning different things when the only difference is that the row ran out of cells.
function combinedOverflowLabel(above: string, below: string, width: number): string {
  const full = `${above}${SOFT_SEP}${below}`;
  const budget = width - SIDEBAR_MARKER_ROW_OVERHEAD;
  if (getTerminalCellWidth(full) <= budget) return full;
  return `${above.replace(' above', '')}${SOFT_SEP}${below.replace(' below', '')}`;
}

function taskHasStatusTail(task: WorkflowTask): boolean {
  return task.status === 'escalated' || task.status === 'failed' || task.status === 'skipped';
}

/** Pieces laid onto as few rows as hold them, broken only between pieces; a piece wider than a row is cut. */
function packPieces(pieces: readonly string[], width: number): string[] {
  const rows: string[] = [];
  for (const piece of pieces) {
    const last = rows.at(-1);
    if (last !== undefined && getTerminalCellWidth(`${last} ${piece}`) <= width) {
      rows[rows.length - 1] = `${last} ${piece}`;
    } else {
      rows.push(piece);
    }
  }
  return rows.map((row) => cutSeatIdentity(row, width));
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
