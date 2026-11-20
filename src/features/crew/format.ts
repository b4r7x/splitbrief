import { CREW_LABEL_WIDTH } from '../../core/crew/identity.js';
import { cutSeatIdentity } from '../../core/crew/seat-line/wrap.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { crewSeatWord } from '../../core/crew/seats.js';

export const CREW_COLUMN_GAP = '  ';
export const CREW_MARKER_GUTTER = 2;

export interface SeatBlockLayout {
  identityWidth: number;
  verdict: boolean;
  rows: number;
}

/** Inner column where every identity starts: cursor gutter, the label and its gap. */
export const CREW_IDENTITY_COLUMN = CREW_MARKER_GUTTER + CREW_LABEL_WIDTH + CREW_COLUMN_GAP.length;

export function planSeatBlock(
  input: Readonly<{
    rows: readonly CrewRow[];
    verdict: CrewLabVerdict | undefined;
    innerWidth: number;
    rowBudget: number;
  }>,
): SeatBlockLayout {
  const identityWidth = input.innerWidth - CREW_IDENTITY_COLUMN;

  let verdict = input.verdict !== undefined;
  const rowCount = (): number => input.rows.length + (verdict ? 1 : 0);

  if (rowCount() > input.rowBudget && verdict) verdict = false;

  return { identityWidth, verdict, rows: rowCount() };
}

/** What a crew row shows beside its label, before the row's own width cuts it. */
function rowContent(row: CrewRow): string {
  return crewSeatWord(row.seat);
}

function rowLabel(row: CrewRow): string {
  return row.seat.label;
}

export function formatCrewRow(
  input: Readonly<{ row: CrewRow; layout: Pick<SeatBlockLayout, 'identityWidth'> }>,
): Readonly<{
  label: string;
  content: string;
}> {
  const { row, layout } = input;
  return {
    label: rowLabel(row).padEnd(CREW_LABEL_WIDTH),
    content: cutSeatIdentity(rowContent(row), layout.identityWidth),
  };
}
