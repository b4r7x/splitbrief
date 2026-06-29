import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import type { ConversationRowKind } from './types.js';

export type RowMarkerStatus = 'live' | 'done' | 'queued';

export function focusBar(): string {
  return `${glyph('liveBar')} `;
}

export function focusBarCells(): number {
  return getTerminalCellWidth(focusBar());
}

export function rowMarker(
  kind: ConversationRowKind,
  status: RowMarkerStatus = 'live',
): string | null {
  if (kind === 'task-header' || kind === 'activity') {
    if (status === 'done') {
      return kind === 'activity' ? `${glyph('stageDone')} ` : `${glyph('statusDone')} `;
    }
    if (status === 'queued') return `${glyph('statusPending')} `;
    return `${glyph('statusInProgress')} `;
  }
  if (kind === 'activity-child') return `  ${glyph('treeBranch')} `;
  if (kind === 'activity-child-last') return `  ${glyph('treeLast')} `;
  if (kind === 'activity-more') return '    ';
  return null;
}

export function rowMarkerCells(kind: ConversationRowKind): number {
  return getTerminalCellWidth(rowMarker(kind) ?? '');
}

export function rowLeadingCells(kind: ConversationRowKind): number {
  const markerCells = rowMarkerCells(kind);
  const focusCells = focusBarCells();
  if (markerCells === 0) return focusCells;
  return focusCells + markerCells;
}
