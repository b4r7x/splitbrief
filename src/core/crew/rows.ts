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
 * An inherited review seat mirrors the planner: it offers no effort of its own, and shows the
 * planner's only while the planner has one.
 */
function effortRow(seat: CrewSeat, plannerEffort: EffortLevel | undefined): CrewRow | undefined {
  if (seat.id === 'review' && seat.source === 'planner') {
    if (plannerEffort === undefined) return undefined;
    return {
      kind: 'effort',
      seatId: seat.id,
      value: plannerEffort,
      editable: false,
      inherited: true,
    };
  }
  if (!seat.supportsEffort) return undefined;
  return { kind: 'effort', seatId: seat.id, value: seat.effort, editable: true, inherited: false };
}

export function deriveCrewRows(input: Readonly<{ config: Config }>): readonly CrewRow[] {
  const seats = deriveCrewSeats(input);
  const plannerEffort = seats.find((seat) => seat.id === 'plan')?.effort;

  const rows: CrewRow[] = [];
  for (const seat of seats) {
    rows.push({ kind: 'seat', id: seat.id, seat });
    const effort = effortRow(seat, plannerEffort);
    if (effort !== undefined) rows.push(effort);
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
      return `effort ${row.value ?? UNSET_EFFORT_WORD}`;
    default:
      return assertNever(row);
  }
}
