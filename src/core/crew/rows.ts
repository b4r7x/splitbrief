import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { isCliToolId } from '../runners/cli-tool-catalog.js';
import type { Config } from '../schemas/config.js';
import { formatSeatIdentity, type CrewSeatId } from './identity.js';
import { deriveCrewSeats, type CrewSeat } from './seats.js';

export type CrewRow = Readonly<{
  id: CrewSeatId;
  seat: CrewSeat;
  /** The declared fallback's identity, when the seat names one. */
  fallback?: string | undefined;
}>;

export type CrewRowKey = `seat:${CrewSeatId}`;

const IDENTITY_SEPARATORS = /[·\s]+/;

type SeatFallback = NonNullable<RunnerConfig['fallback']>;

/**
 * A fallback is spelled like the seat it moves to, not like `<tool> · <model>`:
 * its axis word belongs to the identity, so a model-id channel's axis is peeled
 * off the id and stated once, the same as a configured seat.
 */
function fallbackIdentity(fallback: SeatFallback): string | undefined {
  if (!isCliToolId(fallback.tool)) return undefined;
  return formatSeatIdentity({
    seat: {
      kind: 'cli',
      tool: fallback.tool,
      ...(fallback.model !== undefined && { model: fallback.model }),
      ...(fallback.effort !== undefined && { effort: fallback.effort }),
      ...(fallback.variant !== undefined && { variant: fallback.variant }),
    },
  });
}

export function crewRowKey(row: CrewRow): CrewRowKey {
  return `seat:${row.id}`;
}

export function deriveCrewRows(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): readonly CrewRow[] {
  return deriveCrewSeats(input).map((seat) => {
    const fallback = seat.runner.fallback;
    const identity = fallback === undefined ? undefined : fallbackIdentity(fallback);
    return { id: seat.id, seat, ...(identity !== undefined && { fallback: identity }) };
  });
}

function filterWords(text: string): string {
  return text.toLowerCase().split(IDENTITY_SEPARATORS).filter(Boolean).join(' ');
}

export function crewRowFilterText(row: CrewRow): string {
  return filterWords(`${row.seat.label} ${row.seat.model}`);
}
