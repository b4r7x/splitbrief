import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { seatSupportsEffort } from '../runners/capabilities.js';
import type { ActiveRunnerRole } from '../runners/cli-tool-catalog.js';
import { runnerBillingPosture, type RunnerBillingPosture } from '../runners/runner-billing.js';
import type { Config } from '../schemas/config.js';
import type { EffortLevel } from '../schemas/enums.js';
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
  effort?: EffortLevel | undefined;
  supportsEffort: boolean;
}>;

export type CrewSeat =
  | (CrewSeatRunner & Readonly<{ id: 'plan'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'build'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'review'; label: string; source: 'configured' | 'planner' }>);

function seatRunner(runner: RunnerConfig, id: CrewSeatId): CrewSeatRunner {
  const effort = 'effort' in runner ? runner.effort : undefined;
  return {
    runner,
    model: formatSeatIdentity(runner),
    posture: runnerBillingPosture(runner),
    ...(effort !== undefined && { effort }),
    supportsEffort: seatSupportsEffort({ runner, role: CREW_SEAT_ROLES[id] }),
  };
}

export function deriveCrewSeats(input: Readonly<{ config: Config }>): readonly CrewSeat[] {
  const config = input.config;
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = resolveReviewerRunner(config);

  return [
    { id: 'plan', label: CREW_SEAT_LABELS.plan, ...seatRunner(config.planner, 'plan') },
    {
      id: 'build',
      label: CREW_SEAT_LABELS.build,
      ...seatRunner(implementer, 'build'),
    },
    {
      id: 'review',
      label: CREW_SEAT_LABELS.review,
      source: reviewer.source,
      ...seatRunner(reviewer.runner, 'review'),
    },
  ];
}
