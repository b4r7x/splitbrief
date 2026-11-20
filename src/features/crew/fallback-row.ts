import type { ListRowModel } from '../../components/list-row/plan.js';
import { FALLBACK_NONE_WORDS, type FallbackRow } from '../../core/crew/fallback.js';
import {
  CREW_IDENTITY_SEPARATOR,
  CREW_LABEL_WIDTH,
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
} from '../../core/crew/identity.js';
import { cutSeatIdentity } from '../../core/crew/seat-line/wrap.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { CREW_IDENTITY_COLUMN } from './format.js';

export function fallbackRowModel(row: FallbackRow, width: number): ListRowModel {
  const identity = row.identity ?? FALLBACK_NONE_WORDS;
  const note = row.note === undefined ? '' : '  ' + row.note;
  const content = cutSeatIdentity(
    row.inherited ? `${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${identity}` : identity,
    width - CREW_IDENTITY_COLUMN - getTerminalCellWidth(note),
  );

  const name = CREW_SEAT_LABELS[row.id].padEnd(CREW_LABEL_WIDTH);
  return {
    group: 'fallback',
    name,
    nameParts: [{ text: name, tone: CREW_SEAT_ROLES[row.id], bold: true }],
    description: content,
    trailing: row.note,
    trailingParts: [{ text: row.note ?? '', tone: 'warning' }],
  };
}
