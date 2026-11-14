import { readActiveRunner } from '../../../../../core/config/accessors/active-runner.js';
import { readImplementerProfileConfig } from '../../../../../core/config/accessors/implementer-profiles.js';
import { configError } from '../../../../../core/config/errors.js';
import type { SeatRunnerValue } from '../../../../../core/config/load/record-seat.js';
import { type CrewSeatId, sameSeatCandidate } from '../../../../../core/crew/identity.js';
import { getProviderDisplayName } from '../../../../../core/providers/catalog.js';
import type { Config } from '../../../../../core/schemas/config.js';
import type { RecoveryAction } from '../../../../../core/schemas/enums.js';
import type {
  RecoveryIssue,
  SeatSwapCandidate,
} from '../../../../../core/schemas/recovery/schemas.js';
import { blockRecoveryAction } from '../../actions/shared.js';
import type {
  ApplyRecoveryActionBlocked,
  ApplyRecoveryActionOptions,
} from '../../actions/types.js';
import { readSeatOfRecord } from '../of-record.js';
import { configWithSwitchedSeat, seatCandidateOfRunner } from './config.js';

/** What a seat switch would do before any state or file changes: the offer checked, the failing profile resolved, the switched config built. */
export type SeatSwitchPlan = Readonly<{
  issue: RecoveryIssue;
  seat: CrewSeatId;
  candidate: SeatSwapCandidate;
  /** The identity the seat is leaving, so the record names both ends of the move. */
  from: SeatSwapCandidate;
  switchedConfig: Config;
  auto: boolean;
  configRevision: string | undefined;
}>;

export type SeatSwitchPlanResult =
  | Readonly<{ ok: true; plan: SeatSwitchPlan }>
  | ApplyRecoveryActionBlocked;

/**
 * The half of a seat switch that decides and validates: the seat the halted call
 * ran on, which profile failed, and the run config with that one seat
 * repointed to any tool the seat admits. No state is written and no file is touched, so the caller can
 * prepare on `switchedConfig`, write the seat of record, and only then commit —
 * a stop or a refusal in between leaves the halt pending.
 */
export function planSwitchSeatRecoveryAction(
  opts: Omit<ApplyRecoveryActionOptions, 'action'>,
): SeatSwitchPlanResult {
  const action: RecoveryAction = 'switch-seat';
  const issue = opts.state.pendingRecovery;
  if (!issue) {
    return {
      ok: false,
      action,
      state: opts.state,
      status: 'blocked',
      code: 'no-pending-recovery',
      message: 'No pending recovery issue is available.',
    };
  }

  const offer = issue.switchSeat;
  const first = offer?.candidates[0];
  if (!offer || first === undefined || !issue.availableActions.includes(action)) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'seat-swap-unavailable',
      message: `Recovery issue ${issue.reason} offers no seat to switch to.`,
    });
  }

  const chosen = opts.candidate ?? first;
  if (!opts.config) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'seat-swap-unavailable',
      message: 'Switching a seat requires the run config.',
      publishSelected: true,
    });
  }

  // A build halt names the profile that failed; the swap lands on that profile,
  // and a name the profile table no longer carries changes nothing.
  const failingProfile = offer.seat === 'build' ? issue.selectedImplementerProfile : undefined;
  if (
    failingProfile !== undefined &&
    readImplementerProfileConfig(opts.config, failingProfile) === undefined
  ) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'profile-not-found',
      message: `Profile '${failingProfile}' not found in config.`,
      implementerProfile: failingProfile,
      publishSelected: true,
    });
  }

  const auto = offer.auto !== undefined && sameSeatCandidate(offer.auto.candidate, chosen);
  const record = readSeatOfRecord({
    projectDir: opts.projectDir,
    config: opts.config,
    seat: offer.seat,
    implementerProfile: failingProfile,
  });
  if (record.kind === 'read-failed') {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'fallback-read-failed',
      message: `Cannot switch the ${offer.seat.toUpperCase()} seat: config.yaml does not load. Fix the configuration and try again.`,
      publishSelected: true,
    });
  }
  const switchedConfig = configWithSwitchedSeat(
    opts.config,
    offer.seat,
    chosen,
    failingProfile,
    auto,
    record,
  );
  if (switchedConfig === null) {
    return blockRecoveryAction({
      ...opts,
      action,
      issue,
      code: 'candidate-not-offered',
      message: `${getProviderDisplayName(chosen.tool)} cannot host the ${offer.seat} seat.`,
      publishSelected: true,
    });
  }

  return {
    ok: true,
    plan: {
      issue,
      seat: offer.seat,
      candidate: chosen,
      // A halt saved before the offer recorded its seat has no `from`: the config names it.
      from:
        offer.from ??
        seatCandidateOfRunner(seatRunnerValue(opts.config, offer.seat, failingProfile)),
      switchedConfig,
      auto,
      configRevision: record.configRevision,
    },
  };
}

/** The runner block a seat reads from a config: the failing build profile, the review seat, or the seat's own block. */
export function seatRunnerValue(
  config: Config,
  seat: CrewSeatId,
  profile: string | undefined,
): SeatRunnerValue {
  switch (seat) {
    case 'plan':
      return config.planner;
    case 'review':
      return readActiveRunner({ config, role: 'reviewer' });
    case 'build': {
      const runner = readImplementerProfileConfig(config, profile);
      if (runner === undefined) {
        throw configError.invalidOverride(
          'implementerProfile',
          profile,
          'Profile not found in config.',
        );
      }
      return runner;
    }
  }
}
