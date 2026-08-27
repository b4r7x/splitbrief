import { assertNever } from '../../utils/type-guards.js';
import type { Config } from '../schemas/config.js';
import type { EffortLevel } from '../schemas/enums.js';
import type { CrewSeatId } from './identity.js';
import { deriveCrewSeats, type CrewSeat } from './seats.js';

export type CrewRow =
  | Readonly<{ kind: 'seat'; id: CrewSeatId; seat: CrewSeat }>
  | Readonly<{
      kind: 'effort';
      seatId: CrewSeatId;
      value: EffortLevel | undefined;
      editable: boolean;
      inherited: boolean;
      deliverable: boolean;
    }>;

export type CrewRowKey = `seat:${CrewSeatId}` | `effort:${CrewSeatId}`;

/** An effort nobody set reads as this position, on the row and in the filter alike. */
export const UNSET_EFFORT_WORD = 'auto';
const IDENTITY_SEPARATORS = /[·\s]+/;

export function crewRowKey(row: CrewRow): CrewRowKey {
  switch (row.kind) {
    case 'seat':
      return `seat:${row.id}`;
    case 'effort':
      return `effort:${row.seatId}`;
    default:
      return assertNever(row);
  }
}

/**
 * Every seat always carries an effort row. When review inherits from planner,
 * it mirrors the planner's effort read-only.
 */
function effortRow(seat: CrewSeat, plannerEffort: EffortLevel | undefined): CrewRow {
  if (seat.id === 'review' && seat.source === 'planner') {
    return {
      kind: 'effort',
      seatId: seat.id,
      value: plannerEffort,
      editable: false,
      inherited: true,
      deliverable: seat.supportsEffort,
    };
  }
  return {
    kind: 'effort',
    seatId: seat.id,
    value: seat.effort,
    editable: seat.supportsEffort,
    inherited: false,
    deliverable: seat.supportsEffort,
  };
}

export function deriveCrewRows(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): readonly CrewRow[] {
  const seats = deriveCrewSeats(input);
  const plannerEffort = seats.find((seat) => seat.id === 'plan')?.effort;

  const rows: CrewRow[] = [];
  for (const seat of seats) {
    rows.push({ kind: 'seat', id: seat.id, seat });
    rows.push(effortRow(seat, plannerEffort));
  }
  return rows;
}

function filterWords(text: string): string {
  return text.toLowerCase().split(IDENTITY_SEPARATORS).filter(Boolean).join(' ');
}

export function crewRowFilterText(row: CrewRow): string {
  switch (row.kind) {
    case 'seat':
      return filterWords(`${row.seat.label} ${row.seat.model}`);
    case 'effort':
      if (!row.deliverable && !row.inherited) return 'effort n/a';
      return `effort ${row.value ?? UNSET_EFFORT_WORD}${row.inherited ? ' from planner' : ''}`;
    default:
      return assertNever(row);
  }
}
