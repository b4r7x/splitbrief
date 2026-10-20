import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import { runnerBillingPosture, type RunnerBillingPosture } from '../runners/runner-billing.js';
import type { Config } from '../schemas/config.js';
import { assertNever } from '../../utils/type-guards.js';
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

/** One seat per `CrewSeatId`, in seat order, so a lookup by id is total. */
export type CrewSeats = readonly [
  Extract<CrewSeat, { id: 'plan' }>,
  Extract<CrewSeat, { id: 'build' }>,
  Extract<CrewSeat, { id: 'review' }>,
];

function seatRunner(runner: RunnerConfig, displayName?: string | undefined): CrewSeatRunner {
  return {
    runner,
    model: formatSeatIdentity({ seat: runner, displayName }),
    posture: runnerBillingPosture(runner),
  };
}

export function deriveCrewSeats(
  input: Readonly<{
    config: Config;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): CrewSeats {
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

/**
 * Every CLI tool the config runs in this project: on PLAN, on any BUILD profile,
 * on REVIEW, or as one of their fallbacks.
 */
export function crewCliTools(config: Config): ReadonlySet<string> {
  const runners = [
    config.planner,
    ...resolveImplementerProfiles(config).profiles.map((profile) => profile.config),
    resolveReviewerRunner(config).runner,
  ];
  return new Set(
    runners.flatMap((runner) => [
      ...(runner.kind === 'cli' ? [runner.tool] : []),
      ...(runner.fallback === undefined ? [] : [runner.fallback.tool]),
    ]),
  );
}

/**
 * Where a seat saved under a running run takes over. The run re-reads its seats only at the
 * boundary after a brief, so with no brief left the change waits for a fix brief or the next run.
 */
export type SeatChangePoint =
  | Readonly<{ after: 'brief'; taskId: string }>
  | Readonly<{ after: 'next-brief' }>
  | Readonly<{ after: 'fix-brief-or-next-run' }>;

/** The one wording of a waiting seat change, for the save notice and the composer legend. */
export function seatChangeWords(subject: string, point: SeatChangePoint): string {
  switch (point.after) {
    case 'brief':
      return `${subject} changes after ${point.taskId}`;
    case 'next-brief':
      return `${subject} changes after the next brief`;
    case 'fix-brief-or-next-run':
      return `${subject} changes after a fix brief or at the next run`;
    default:
      return assertNever(point);
  }
}
