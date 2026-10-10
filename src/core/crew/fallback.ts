import { readActiveRunner } from '../config/accessors/active-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import type { CliToolDetection } from '../discovery/detection.js';
import { isCliToolId } from '../runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import type { Config } from '../schemas/config.js';
import { SOFT_SEP } from '../separators.js';
import { formatSeatIdentity, isSeatIdentity, type CrewSeatId } from './identity.js';
import { CREW_SEAT_ROLES, deriveCrewSeats } from './seats.js';

export type SeatFallback = NonNullable<RunnerConfig['fallback']>;

export type FallbackRowKey = `fallback:${CrewSeatId}`;

export type FallbackRow = Readonly<{
  id: CrewSeatId;
  /** The fallback the seat resolves to; undefined means none. */
  fallback?: SeatFallback | undefined;
  /** The fallback spelled like a seat (formatSeatIdentity of fallbackRunner). */
  identity?: string | undefined;
  /** REVIEW with no block of its own: it runs PLAN's fallback. */
  inherited: boolean;
  /** Why a halt would not take it: 'same as the seat', 'not installed', or the readiness state word. */
  note?: string | undefined;
}>;

export const FALLBACK_NONE_WORDS = `none${SOFT_SEP}pause and ask`;

export function fallbackRowKey(row: FallbackRow): FallbackRowKey {
  return `fallback:${row.id}`;
}

export function seatFallback(config: Config, role: ActiveRunnerRole): SeatFallback | undefined {
  return readActiveRunner({ config, role }).fallback;
}

/**
 * A fallback is spelled like the seat it moves to, not like `<tool> · <model>`:
 * its axis word belongs to the identity, so a model-id channel's axis is peeled
 * off the id and stated once, the same as a configured seat.
 */
export function fallbackRunner(fallback: SeatFallback): RunnerConfig | undefined {
  if (!isCliToolId(fallback.tool)) return undefined;
  return {
    kind: 'cli',
    tool: fallback.tool,
    ...(fallback.model !== undefined && { model: fallback.model }),
    ...(fallback.effort !== undefined && { effort: fallback.effort }),
    ...(fallback.variant !== undefined && { variant: fallback.variant }),
  };
}

export function fallbackBlockedReason(detection: CliToolDetection | undefined): string | undefined {
  const state = detection?.diagnostic.state;
  if (state === undefined || state === 'unavailable') return 'not installed';
  return state === 'ready' || state === 'unverified' ? undefined : state;
}

export function deriveFallbackRows(
  input: Readonly<{ config: Config; cliTools: readonly CliToolDetection[] }>,
): readonly FallbackRow[] {
  return deriveCrewSeats({ config: input.config }).map((seat) => {
    const fallback = seatFallback(input.config, CREW_SEAT_ROLES[seat.id]);
    const inherited = seat.id === 'review' && seat.source === 'planner';
    if (fallback === undefined) return { id: seat.id, inherited };
    const runner = fallbackRunner(fallback);
    const identity = runner === undefined ? undefined : formatSeatIdentity({ seat: runner });
    const note = isSeatIdentity(
      { tool: seat.runner.kind === 'cli' ? seat.runner.tool : '', model: seat.runner.model },
      fallback,
    )
      ? 'same as the seat'
      : fallbackBlockedReason(input.cliTools.find((detection) => detection.tool === fallback.tool));
    return {
      id: seat.id,
      fallback,
      inherited,
      ...(identity !== undefined && { identity }),
      ...(note !== undefined && { note }),
    };
  });
}
