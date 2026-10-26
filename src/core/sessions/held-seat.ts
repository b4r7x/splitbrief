import { getRunnerDisplayName, type RunnerConfig } from '../config/accessors/runner-config.js';
import { readActiveRunner } from '../config/accessors/active-runner.js';
import { readImplementerProfileConfig } from '../config/accessors/implementer-profiles.js';
import type { CrewSeatId } from '../crew/identity.js';
import { CREW_SEAT_ROLES } from '../crew/seats.js';
import type { Config } from '../schemas/config.js';
import type { HeldSeat, SeatWait } from '../schemas/workflow.js';

export function heldSeatOf(runner: RunnerConfig, profile: string | undefined): HeldSeat {
  return {
    tool: getRunnerDisplayName(runner),
    kind: runner.kind,
    ...(profile !== undefined && { profile }),
  };
}

/**
 * The seat a config runs for a wait: the BUILD profile the wait names, else the default one, and
 * the planner for a REVIEW seat with no reviewer. A BUILD profile the config no longer has runs none.
 */
export function configuredHeldSeat(
  config: Config,
  seat: CrewSeatId,
  profile: string | undefined,
): HeldSeat | undefined {
  const runner =
    seat === 'build'
      ? readImplementerProfileConfig(config, profile)
      : readActiveRunner({ config, role: CREW_SEAT_ROLES[seat] });
  return runner === undefined ? undefined : heldSeatOf(runner, profile);
}

/** Whether a seat runs on a runner; a runner recorded without its kind matches any kind. */
function runsOn(
  seat: HeldSeat | undefined,
  runner: Readonly<{ tool?: string | undefined; kind?: HeldSeat['kind'] | undefined }>,
): boolean {
  return (
    seat !== undefined &&
    seat.tool === runner.tool &&
    (runner.kind === undefined || seat.kind === runner.kind)
  );
}

export function seatWaitMoved(wait: SeatWait, config: Config): boolean {
  if (wait.holds === undefined) return false;
  const runs = configuredHeldSeat(config, wait.seat, wait.holds.profile);
  return !runsOn(runs, wait.holds) && !runsOn(runs, wait);
}
