import { routerStore } from '../../../stores/navigation/router.js';
import { wrapHard } from '../../../utils/wrap.js';
import { selectRunningBrief, tasksStore } from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

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
export const STOP_SHEET_LEGEND = '↑↓ select · enter confirm · esc stop · tab back';

export function stopMenuLayout(rows: readonly StopRow[], cols: number) {
  // The sheet renders inside the screen frame, so its cap is the framed width.
  const width = Math.min(getChromeContentWidth(cols), 96);
  const innerWidth = Math.max(1, width - 6);
  const options = rows.map((row) => ({
    row,
    lines: wrapHard(`${row.label} · ${row.consequence}`, innerWidth).split('\n'),
  }));
  const bodyRows = rows.length + Math.max(0, ...options.map((option) => option.lines.length - 1));
  return { width, bodyRows, height: bodyRows + 4, options };
}

export interface StopSheetInput {
  readonly currentTaskId: string | null;
  readonly nextTaskId: string | null;
  readonly boundaryPauseRequested: boolean;
}

export function stopSheetRows(input: StopSheetInput): StopRow[] {
  const rows: StopRow[] = [
    { id: 'stop-now', label: 'Stop now', consequence: 'stop execution; keep partial changes' },
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
    consequence: 'stop execution; mark this run cancelled; keep changes',
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
    return [
      ...(!closed
        ? [
            {
              id: 'resume' as const,
              label: 'Resume',
              consequence: 'continue this run; keep the unsent draft',
            },
            {
              id: 'end-run' as const,
              label: 'End run',
              consequence: 'close this run; keep changes',
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
  const brief = selectRunningBrief(tasksStore.get());
  return stopSheetRows({
    currentTaskId: brief.current?.id ?? null,
    nextTaskId: brief.next?.id ?? null,
    boundaryPauseRequested: stopStore.get().intent === 'pause-after-brief',
  });
}
