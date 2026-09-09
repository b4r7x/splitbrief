import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import { runnerBillingPosture, type RunnerBillingPosture } from '../runners/runner-billing.js';
import type { Config } from '../schemas/config.js';
import { CREW_SEAT_LABELS, formatSeatIdentity, type CrewSeatId } from './identity.js';

export const CREW_SEAT_ROLES: Readonly<Record<CrewSeatId, ActiveRunnerRole>> = {
  plan: 'planner',
  build: 'implementer',
  review: 'reviewer',
};

export type CrewSeatRunner = Readonly<{
  runner: RunnerConfig;
  /** The composed seat identity, sanitized and ready to measure. */
  model: string;
  posture: RunnerBillingPosture;
}>;

export type CrewSeat =
  | (CrewSeatRunner & Readonly<{ id: 'plan'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'build'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'review'; label: string; source: 'configured' | 'planner' }>);

function seatRunner(runner: RunnerConfig, displayName?: string | undefined): CrewSeatRunner {
  return {
    runner,
    model: formatSeatIdentity(runner, displayName),
    posture: runnerBillingPosture(runner),
  };
}

export function deriveCrewSeats(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): readonly CrewSeat[] {
  const config = input.config;
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = resolveReviewerRunner(config);
  const displayNames = input.displayNames;

  return [
    {
      id: 'plan',
      label: CREW_SEAT_LABELS.plan,
      ...seatRunner(config.planner, displayNames?.plan),
    },
    {
      id: 'build',
      label: CREW_SEAT_LABELS.build,
      ...seatRunner(implementer, displayNames?.build),
    },
    {
      id: 'review',
      label: CREW_SEAT_LABELS.review,
      source: reviewer.source,
      ...seatRunner(
        reviewer.runner,
        displayNames?.review ?? (reviewer.source === 'planner' ? displayNames?.plan : undefined),
      ),
    },
  ];
}
