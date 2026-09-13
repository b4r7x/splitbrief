export type StopRowId = 'stop-now' | 'pause-after-brief' | 'keep-running' | 'end-run';

export interface StopRow {
  readonly id: StopRowId;
  readonly label: string;
  /** What the run looks like after the row is chosen, in the same voice on every row. */
  readonly consequence: string;
}

export const STOP_SHEET_TITLE = 'Stop options';
export const STOP_SHEET_FOOTER = 'No option reverts files. Your draft is preserved.';
export const STOP_SHEET_LEGEND = '↑↓ · ⏎ · esc';

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
