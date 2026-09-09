import {
  CREW_IDENTITY_SEPARATOR,
  CREW_LABEL_WIDTH,
  PLANNER_INHERITANCE,
  cutSeatIdentity,
} from '../../core/crew/identity.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import type { CrewSeat } from '../../core/crew/seats.js';
import { billingWord } from '../../core/runners/runner-billing.js';

export const CREW_COLUMN_GAP = '  ';
export const CREW_MARKER_GUTTER = 2;
/** Below this a truncated model id no longer names a model, so the posture tag yields the room. */
const MIN_IDENTITY_WIDTH = 28;

export interface SeatBlockLayout {
  identityWidth: number;
  posture: boolean;
  verdict: boolean;
  rows: number;
}

/** Inner column where every identity starts: cursor gutter, the label and its gap. */
export const CREW_IDENTITY_COLUMN = CREW_MARKER_GUTTER + CREW_LABEL_WIDTH + CREW_COLUMN_GAP.length;
/** The widest posture word plus the gap that separates it from the identity column. */
const CREW_POSTURE_COLUMN = 14;

export function planSeatBlock(
  input: Readonly<{
    rows: readonly CrewRow[];
    verdict: CrewLabVerdict | undefined;
    innerWidth: number;
    rowBudget: number;
  }>,
): SeatBlockLayout {
  const posture =
    input.innerWidth - CREW_IDENTITY_COLUMN - CREW_POSTURE_COLUMN >= MIN_IDENTITY_WIDTH;
  const identityWidth =
    input.innerWidth - CREW_IDENTITY_COLUMN - (posture ? CREW_POSTURE_COLUMN : 0);

  let verdict = input.verdict !== undefined;
  const rowCount = (): number => input.rows.length + (verdict ? 1 : 0);

  if (rowCount() > input.rowBudget && verdict) verdict = false;

  return { identityWidth, posture, verdict, rows: rowCount() };
}

function seatContent(seat: CrewSeat): string {
  return seat.id === 'review' && seat.source === 'planner'
    ? `${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${seat.model}`
    : seat.model;
}

function rowContent(row: CrewRow): string {
  return seatContent(row.seat);
}

function rowLabel(row: CrewRow): string {
  return row.seat.label;
}

export function formatCrewRow(
  input: Readonly<{ row: CrewRow; layout: SeatBlockLayout }>,
): Readonly<{
  label: string;
  content: string;
  posture?: string | undefined;
}> {
  const { row, layout } = input;
  const posture = layout.posture ? billingWord(row.seat.posture) : undefined;
  return {
    label: rowLabel(row).padEnd(CREW_LABEL_WIDTH),
    content: cutSeatIdentity(rowContent(row), layout.identityWidth),
    ...(posture !== undefined && { posture }),
  };
}
