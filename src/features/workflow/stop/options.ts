import { routerStore } from '../../../stores/navigation/router.js';
import {
  selectRunningBrief,
  selectTaskListView,
  tasksStore,
  type TasksState,
} from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { getTerminalCellWidth, segmentsForRowText } from '../../../utils/display-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { wrappedProseSegments } from '../conversation-rows/row-format/text.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { changedFileCount } from '../closed/projections.js';

export type StopRowId =
  | 'stop-now'
  | 'pause-after-brief'
  | 'keep-running'
  | 'end-run'
  | 'resume'
  | 'leave'
  | 'retry-stop';

export interface StopRow {
  readonly id: StopRowId;
  readonly label: string;
  /** What the run looks like after the row is chosen, in the same voice on every row. */
  readonly consequence: string;
}

export const STOP_SHEET_TITLE = 'Stop options';
export const STOP_SHEET_FOOTER = 'Changes and draft stay.';
export const STOP_SHEET_LEGEND = '↑↓ select · ⏎ confirm · esc stop · tab close';
export const STOP_SHEET_PARKED_LEGEND = '↑↓ select · ⏎ confirm · esc back · tab close';

/** A wrapped consequence hangs in from its label, so a continuation never reads as another row. */
const CONSEQUENCE_HANG = '  ';

// A consequence is a list of clauses. A row breaks after a `;` wherever the next clause fits on the
// line below, so no line ends on half a clause (`do` above `not start T003`).
function wrapClauses(
  source: readonly ConversationRowSegment[],
  width: number,
): ConversationRowSegment[][] {
  const text = source.map((part) => part.text).join('');
  const lines: ConversationRowSegment[][] = [];
  let current: ConversationRowSegment[] = [];
  let offset = 0;
  for (const clause of text.split(/(?<=;) /u)) {
    const clauseParts = segmentsForRowText(source, clause, offset);
    const currentText = current.map((part) => part.text).join('');
    const joined = [
      ...current,
      ...(currentText === '' ? [] : segmentsForRowText(source, ' ', offset - 1)),
      ...clauseParts,
    ];
    if (getTerminalCellWidth(joined.map((part) => part.text).join('')) <= width) {
      current = joined;
    } else if (getTerminalCellWidth(clause) <= width) {
      lines.push(current);
      current = clauseParts;
    } else {
      const wrapped = wrappedProseSegments(joined, width);
      lines.push(...wrapped.slice(0, -1));
      current = wrapped.at(-1) ?? [];
    }
    offset += clause.length + 1;
  }
  return [...lines, current];
}

export function stopMenuLayout<
  Row extends { readonly label: string; readonly consequence: string },
>(rows: readonly Row[], cols: number) {
  // The sheet stacks on the composer inside the gutter, so it takes the composer's width and the
  // two boxes share both edges.
  const width = getChromeContentWidth(cols);
  const innerWidth = Math.max(1, width - 6);
  const options = rows.map((row) => {
    const source: ConversationRowSegment[] = [
      { text: row.label, tone: 'text' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: row.consequence, tone: 'textDim' },
    ];
    const parts = wrapClauses(source, Math.max(1, innerWidth - CONSEQUENCE_HANG.length)).map(
      (line, index) => {
        return index === 0
          ? line
          : [{ text: CONSEQUENCE_HANG, tone: 'textDim' } satisfies ConversationRowSegment, ...line];
      },
    );
    return { row, parts, lines: parts.map((line) => line.map((part) => part.text).join('')) };
  });
  // Every row states its consequence, so the sheet is exactly as tall as what it paints whichever
  // row is selected: the transcript above holds still as the cursor moves, and no row stands blank.
  const bodyRows = options.reduce((total, option) => total + option.lines.length, 0);
  return { width, bodyRows, height: bodyRows + 4, options };
}

export interface StopSheetInput {
  readonly currentTaskId: string | null;
  readonly nextTaskId: string | null;
  /** A brief has run, so the run has changes to keep. */
  readonly hasChanges?: boolean | undefined;
  readonly boundaryPauseRequested: boolean;
}

export function stopSheetRows(input: StopSheetInput): StopRow[] {
  const rows: StopRow[] = [
    {
      id: 'stop-now',
      label: 'Stop now',
      consequence:
        input.currentTaskId === null
          ? 'stop execution; keep the run open'
          : 'stop execution; keep partial changes',
    },
  ];
  // A pause that is already pending has nothing left to ask for: the second row is the way back.
  if (input.boundaryPauseRequested) {
    rows.push({
      id: 'keep-running',
      label: 'Keep running',
      consequence: 'cancel the pause; the run continues',
    });
  } else if (input.currentTaskId !== null) {
    rows.push({
      id: 'pause-after-brief',
      label: 'Pause after this brief',
      consequence: `finish ${input.currentTaskId} including checks and review; do not start ${input.nextTaskId ?? 'another brief'}`,
    });
  }
  rows.push({
    id: 'end-run',
    label: 'End run',
    consequence:
      input.hasChanges === true
        ? 'stop execution; close this run; keep changes'
        : 'stop execution; close this run',
  });
  return rows;
}

export function readStopMenuRows(): StopRow[] {
  const stop = stopStore.get();
  if (stop.phase === 'failed')
    return [
      {
        id: 'retry-stop',
        label: 'Retry stop',
        consequence: 'retry cleanup and saving; do not start new work',
      },
    ];
  const route = routerStore.get();
  const atRest = route.screen === 'workflow' && route.execution.kind === 'at-rest';
  if (stop.phase === 'parked' || stop.phase === 'ended' || atRest) {
    const closed = stop.phase === 'ended' || (atRest && route.run.status.kind === 'closed');
    // A ready run cannot be continued: Apply and Discard live in its result menu, and End run
    // discards it the same way.
    const ready = atRest && route.run.status.kind === 'ready-to-apply';
    return [
      ...(ready
        ? [
            {
              id: 'end-run' as const,
              label: 'End run',
              consequence:
                changedFileCount(route.run.summary) === 0
                  ? 'discard the result; it changed no files'
                  : 'discard the result; save its changes in run.patch',
            },
          ]
        : !closed
          ? [
              {
                id: 'resume' as const,
                label: 'Resume',
                consequence: 'continue this run; keep the unsent draft',
              },
              {
                id: 'end-run' as const,
                label: 'End run',
                consequence: briefsHaveRun(tasksStore.get(), lifecycleStore.get().phase)
                  ? 'close this run; keep changes'
                  : 'close this run',
              },
            ]
          : []),
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: 'return home; keep the run and draft',
      },
    ];
  }
  if (stop.intent !== 'none' && stop.intent !== 'pause-after-brief')
    return [
      {
        id: 'leave',
        label: 'Back after stop',
        consequence: 'return to sessions once cleanup and saving finish',
      },
    ];
  const tasks = tasksStore.get();
  const brief = selectRunningBrief(tasks, lifecycleStore.get().phase);
  const rows = stopSheetRows({
    currentTaskId: brief.current?.id ?? null,
    nextTaskId: brief.next?.id ?? null,
    hasChanges: briefsHaveRun(tasks, lifecycleStore.get().phase),
    boundaryPauseRequested: stop.intent === 'pause-after-brief',
  });
  return recoveryNoticeStore.get().issue === null
    ? rows
    : rows.filter((row) => row.id === 'stop-now' || row.id === 'end-run');
}

/** A brief that ran left changes behind; until the first one starts, the run has none to keep. */
function briefsHaveRun(tasks: TasksState, phase: Phase): boolean {
  const view = selectTaskListView(tasks);
  return selectRunningBrief(tasks, phase).current !== null || view.finished + view.failed > 0;
}

/** What every row keeps: the draft always, the run's changes once a brief has made some. */
export function stopSheetFooter(input: { hasChanges: boolean }): string {
  return input.hasChanges ? STOP_SHEET_FOOTER : 'Draft stays.';
}

export function readStopSheetFooter(): string {
  return stopSheetFooter({
    hasChanges: briefsHaveRun(tasksStore.get(), lifecycleStore.get().phase),
  });
}
