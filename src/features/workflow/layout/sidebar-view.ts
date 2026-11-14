import {
  type CrewSeatId,
  CREW_LABEL_WIDTH,
  formatSeatIdentity,
} from '../../../core/crew/identity.js';
import { wrapSeatIdentity, cutSeatIdentity } from '../../../core/crew/seat-line/wrap.js';
import { type CrewSeat, crewSeatWord } from '../../../core/crew/seats.js';
import type { TaskListView, WorkflowTask } from '../../../core/run-view/briefs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { SeatResolvedModel } from '../../../stores/workflow/tokens/state.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText, getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import { seatIdentityPieces } from '../closed/copy/crew-line.js';
import type { RecordedCrew } from '../closed/view-model.js';
import { taskOutcomeCountsSpans, passedCountSpans } from '../display/build-progress/counts.js';
import { type RunningSeats, resolvedSeatModel } from '../display/running-seats.js';
import {
  getSidebarFooterBudget,
  getSidebarTaskListRows,
  getSidebarTaskWindow,
  getSidebarStatusColumnCells,
} from './rect.js';

// Bar, marker, and the space after it — the cells a task row paints before its title.
export const LIST_INDENT = '   ';
// 2 border cells + the 1-cell right padding + the indent a marker row shares with the title column;
// the bar sits in the cell the left padding would take.
const SIDEBAR_MARKER_ROW_OVERHEAD = 3 + LIST_INDENT.length;

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

interface SeatRows {
  seat: CrewSeat;
  rows: string[];
}

interface SidebarViewInput {
  view: TaskListView;
  seats: readonly CrewSeat[];
  displayNames: Partial<Record<CrewSeatId, string>>;
  running: RunningSeats;
  resolvedModels: Partial<Record<CrewSeatId, SeatResolvedModel>>;
  /** The crew the run's record names (`recordedCrew`); without it the crew is today's. */
  recordedCrew: RecordedCrew | undefined;
  width: number;
  /** Without a height the caller is not budgeting rows, so the list never windows. */
  height: number | undefined;
}

export function deriveSidebarView({
  view,
  seats,
  displayNames,
  running,
  resolvedModels,
  recordedCrew,
  width,
  height,
}: SidebarViewInput) {
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
                        displayName: displayNames[seat.id],
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
  const aboveLabel = overflowLabel(tasks.slice(0, listWindow.start), 'done', 'done', 'above');
  const belowLabel = overflowLabel(tasks.slice(listWindow.end), 'pending', 'queued', 'below');
  const tail = [
    listWindow.combine ? combinedOverflowLabel(aboveLabel, belowLabel, width) : '',
    listWindow.showBelow ? belowLabel : '',
    view.unannounced > 0 ? `+${view.unannounced} more` : '',
  ].filter((part) => part !== '');

  return {
    title: truncateTerminalDisplayText(
      view.total === 0 ? 'Tasks' : `Tasks ${view.passed}/${view.total}`,
      innerWidth,
    ),
    innerWidth,
    visible: tasks.slice(listWindow.start, listWindow.end),
    /** The row above the visible tasks that names what the window hid there; none when not shown. */
    aboveLabel: listWindow.showAbove ? aboveLabel : undefined,
    /** The row under the visible tasks: the hidden edges and the unannounced count. */
    tailLabel: tail.length > 0 ? tail.join(SOFT_SEP) : undefined,
    statusCells: getSidebarStatusColumnCells({ hasStatusTail: tasks.some(taskHasStatusTail) }),
    outcomeRows: outcomeRowSpans,
    seatRows,
  };
}
