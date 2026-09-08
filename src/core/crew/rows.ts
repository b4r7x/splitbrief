import { assertNever } from '../../utils/type-guards.js';
import { UNSET_EFFORT_WORD, type CliEffortChannel } from '../runners/effort-channel.js';
import type { Config } from '../schemas/config.js';
import type { CrewSeatId } from './identity.js';
import { deriveCrewSeats, type CrewSeat } from './seats.js';

export type CrewRow =
  | Readonly<{ kind: 'seat'; id: CrewSeatId; seat: CrewSeat }>
  | Readonly<{
      kind: 'effort';
      seatId: CrewSeatId;
      channel: CliEffortChannel;
      /** The effort level, the verbatim variant name, or the id-spelled token. */
      value: string | undefined;
      editable: boolean;
      inherited: boolean;
      deliverable: boolean;
    }>;

export type CrewRowKey = `seat:${CrewSeatId}` | `effort:${CrewSeatId}`;

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

type PlannerEffort = Readonly<{ channel: CliEffortChannel; value: string | undefined }>;

/**
 * Every seat always carries an effort row. When review inherits from planner,
 * it mirrors the planner's channel and value read-only.
 */
function effortRow(seat: CrewSeat, planner: PlannerEffort): CrewRow {
  if (seat.id === 'review' && seat.source === 'planner') {
    return {
      kind: 'effort',
      seatId: seat.id,
      channel: planner.channel,
      value: planner.value,
      editable: false,
      inherited: true,
      deliverable: planner.channel !== 'none',
    };
  }
  return {
    kind: 'effort',
    seatId: seat.id,
    channel: seat.channel,
    value: seat.effortValue,
    editable: seat.effortEditable,
    inherited: false,
    deliverable: seat.channel !== 'none',
  };
}

export function deriveCrewRows(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): readonly CrewRow[] {
  const seats = deriveCrewSeats(input);
  const plan = seats.find((seat) => seat.id === 'plan');
  const planner: PlannerEffort = {
    channel: plan?.channel ?? 'none',
    value: plan?.effortValue,
  };

  const rows: CrewRow[] = [];
  for (const seat of seats) {
    rows.push({ kind: 'seat', id: seat.id, seat });
    rows.push(effortRow(seat, planner));
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
      if (row.channel === 'none' && !row.inherited) return 'effort n/a';
      return `effort ${row.value ?? UNSET_EFFORT_WORD}${row.inherited ? ' from planner' : ''}`;
    default:
      return assertNever(row);
  }
}
