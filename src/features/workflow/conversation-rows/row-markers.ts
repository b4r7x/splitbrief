import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import type { ConversationRowKind } from './types.js';

export type RowMarkerStatus = 'live' | 'done' | 'queued';

// The full leading from terminal column 0: a 2-cell glyph slot for block-level rows, 4 cells for
// tree children hanging under a header. The hover bar overlays cell 0 instead of reserving a slot.
export function rowLeading(kind: ConversationRowKind, status: RowMarkerStatus = 'live'): string {
  if (kind === 'prompt') return `${glyph('promptMarker')} `;
  if (kind === 'task-header' || kind === 'activity') {
    if (status === 'done') {
      return kind === 'activity' ? `${glyph('stageDone')} ` : `${glyph('statusDone')} `;
    }
    if (status === 'queued') return `${glyph('statusPending')} `;
    return `${glyph('statusInProgress')} `;
  }
  if (kind === 'callout-top' || kind === 'callout-body') return `${glyph('treeMid')} `;
  if (kind === 'activity-child') return `  ${glyph('treeBranch')} `;
  if (kind === 'activity-child-last') return `  ${glyph('treeLast')} `;
  if (kind === 'activity-more') return '    ';
  return '  ';
}

export function rowLeadingCells(kind: ConversationRowKind): number {
  return getTerminalCellWidth(rowLeading(kind));
}

export function wrapWidthFor(kind: ConversationRowKind, width: number): number {
  return Math.max(1, width - rowLeadingCells(kind));
}
