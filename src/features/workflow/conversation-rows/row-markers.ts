import { getTerminalCellWidth } from '../../../utils/display-text.js';
import type { ConversationRowKind } from './types.js';

export function rowMarker(kind: ConversationRowKind): string | null {
  if (kind === 'task-header' || kind === 'activity') return '⏺ ';
  if (kind === 'activity-child') return '  │ ';
  if (kind === 'activity-child-last') return '  └ ';
  if (kind === 'activity-more') return '  ⋯ ';
  return null;
}

export function rowMarkerCells(kind: ConversationRowKind): number {
  return getTerminalCellWidth(rowMarker(kind) ?? '');
}
