import { cutSeatIdentity } from '../../../core/crew/seat-line/wrap.js';
import type { WorkflowTask } from '../../../core/run-view/briefs.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';

// Bar, marker, and the space after it — the cells a task row paints before its title.
export const LIST_INDENT = '   ';
// 2 border cells + the 1-cell right padding + the indent a marker row shares with the title column;
// the bar sits in the cell the left padding would take.
const SIDEBAR_MARKER_ROW_OVERHEAD = 3 + LIST_INDENT.length;

// The running task anchors the window; once every task has settled the tail is the useful end.
export function anchorIndex(tasks: readonly WorkflowTask[]): number {
  const running = tasks.findIndex((task) => task.status === 'in_progress');
  return running >= 0 ? running : Math.max(0, tasks.length - 1);
}

// The list follows the run rather than scrolling, so a bare count would be a dead end: it says work
// is out of view without saying what it is. Naming the state when the hidden slice is uniform tells
// the reader nothing actionable is hiding up there; a mixed slice falls back to the plain count.
export function overflowLabel(
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
export function combinedOverflowLabel(above: string, below: string, width: number): string {
  const full = `${above}${SOFT_SEP}${below}`;
  const budget = width - SIDEBAR_MARKER_ROW_OVERHEAD;
  if (getTerminalCellWidth(full) <= budget) return full;
  return `${above.replace(' above', '')}${SOFT_SEP}${below.replace(' below', '')}`;
}

export function taskHasStatusTail(task: WorkflowTask): boolean {
  return task.status === 'escalated' || task.status === 'failed' || task.status === 'skipped';
}

/** Pieces laid onto as few rows as hold them, broken only between pieces; a piece wider than a row is cut. */
export function packPieces(pieces: readonly string[], width: number): string[] {
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
