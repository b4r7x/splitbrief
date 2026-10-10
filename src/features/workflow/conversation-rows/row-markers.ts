import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { ROW_LEADING, TEXT_LEADING } from '../../../components/row-leading.js';
import type { ConversationRowKind } from './types.js';

export type RowMarkerStatus = 'live' | 'done' | 'queued';

// The full leading from terminal column 0: cell 0 is the empty padding the hover bar paints into,
// a row that carries a mark puts it on column 1 with content on column 3, and an unmarked row
// leaves the mark slot blank and starts its content on column 3 all the same — column 1 is the
// centred glyphs' column, and text never enters it.
export function rowLeading(kind: ConversationRowKind, status: RowMarkerStatus = 'live'): string {
  if (kind === 'prompt') return `${ROW_LEADING}${glyph('promptMarker')} `;
  if (kind === 'task-header' || kind === 'activity') {
    if (status === 'done') return `${ROW_LEADING}${glyph('stageDone')} `;
    if (status === 'queued') return `${ROW_LEADING}${glyph('statusPending')} `;
    return `${ROW_LEADING}${glyph('statusInProgress')} `;
  }
  if (kind === 'callout-top' || kind === 'callout-body')
    return `${ROW_LEADING}${glyph('treeMid')} `;
  if (kind === 'activity-child') return `${ROW_LEADING}${glyph('treeBranch')} `;
  if (kind === 'activity-child-last') return `${ROW_LEADING}${glyph('treeLast')} `;
  if (kind === 'activity-more') return TEXT_LEADING;
  return TEXT_LEADING;
}

export function rowLeadingCells(kind: ConversationRowKind): number {
  return getTerminalCellWidth(rowLeading(kind));
}

export function wrapWidthFor(kind: ConversationRowKind, width: number): number {
  return Math.max(1, width - rowLeadingCells(kind));
}
