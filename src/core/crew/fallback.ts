import { readActiveRunner } from '../config/accessors/active-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import type { SavedCatalog, SavedCatalogOf } from '../discovery/catalog-read-merge.js';
import type { CliToolDetection } from '../discovery/detection.js';
import { seatRouteModel } from '../providers/automatic-model.js';
import { isCliToolId } from '../runners/cli-tool-catalog.js';
import { ROUTE_NEEDS_SIGN_IN, routeAuthState } from '../runners/route-auth.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import type { Config } from '../schemas/config.js';
import { SOFT_SEP } from '../separators.js';
import {
  formatSeatIdentity,
  isSeatIdentity,
  type CrewSeatId,
  type SeatDisplayName,
} from './identity.js';
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
  /**
   * Why a halt would not take it: 'same as the seat', 'not installed', the readiness state word, or
   * the route word 'needs sign-in'.
   */
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

/**
 * Why a halt would not take the fallback. A tool that stores no credential still calls a route its
 * model list serves, so a fallback on such a route is taken; a fallback on `auto` or with no model
 * calls the model the tool selects on this host, the same as a seat. A ready or unverified tool's
 * route that needs a sign-in is refused on every call, so the note names the route word the picker
 * shows.
 */
export function fallbackBlockedReason(
  fallback: SeatFallback,
  detection: CliToolDetection | undefined,
  catalog: SavedCatalog | null | undefined,
): string | undefined {
  const state = detection?.diagnostic.state;
  if (state === undefined || state === 'unavailable') return 'not installed';
  const route = routeAuthState({
    tool: detection?.tool,
    model: seatRouteModel(fallback.model, fallback.tool, detection?.selectedModel),
    providerAuth: detection?.providerAuth,
    catalog,
  });
  if (state === 'ready' || state === 'unverified') {
    return route.kind === 'needs-sign-in' ? ROUTE_NEEDS_SIGN_IN : undefined;
  }
  return state === 'unauthenticated' && route.kind === 'configured' ? undefined : state;
}

export function deriveFallbackRows(
  input: Readonly<{
    config: Config;
    cliTools: readonly CliToolDetection[];
    /** Each CLI tool's own model listing, which tells a provider set up in the tool's config. */
    cliCatalog?: SavedCatalogOf | undefined;
    seatDisplayName?: SeatDisplayName | undefined;
  }>,
): readonly FallbackRow[] {
  return deriveCrewSeats({ config: input.config }).map((seat) => {
    const fallback = seatFallback(input.config, CREW_SEAT_ROLES[seat.id]);
    const inherited = seat.id === 'review' && seat.source === 'planner';
    if (fallback === undefined) return { id: seat.id, inherited };
    const runner = fallbackRunner(fallback);
    const identity =
      runner === undefined
        ? undefined
        : formatSeatIdentity({
            seat: runner,
            displayName: input.seatDisplayName?.(runner, CREW_SEAT_ROLES[seat.id]),
          });
    const detection = input.cliTools.find((candidate) => candidate.tool === fallback.tool);
    const note = isSeatIdentity(
      { tool: seat.runner.kind === 'cli' ? seat.runner.tool : '', model: seat.runner.model },
      fallback,
    )
      ? 'same as the seat'
      : fallbackBlockedReason(
          fallback,
          detection,
          detection === undefined ? undefined : input.cliCatalog?.(detection.tool),
        );
    return {
      id: seat.id,
      fallback,
      inherited,
      ...(identity !== undefined && { identity }),
      ...(note !== undefined && { note }),
    };
  });
}
