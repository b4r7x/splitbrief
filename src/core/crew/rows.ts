import type { Config } from '../schemas/config.js';
import type { CrewSeatId } from './identity.js';
import { deriveCrewSeats, type CrewSeat } from './seats.js';

export type CrewRow = Readonly<{ id: CrewSeatId; seat: CrewSeat }>;

export type CrewRowKey = `seat:${CrewSeatId}`;

const IDENTITY_SEPARATORS = /[·\s]+/;

export function crewRowKey(row: CrewRow): CrewRowKey {
  return `seat:${row.id}`;
}

export function deriveCrewRows(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): readonly CrewRow[] {
  return deriveCrewSeats(input).map((seat) => ({ id: seat.id, seat }));
}

function filterWords(text: string): string {
  return text.toLowerCase().split(IDENTITY_SEPARATORS).filter(Boolean).join(' ');
}

export function crewRowFilterText(row: CrewRow): string {
  return filterWords(`${row.seat.label} ${row.seat.model}`);
}
