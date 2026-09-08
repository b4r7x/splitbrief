import { assertNever } from '../../utils/type-guards.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { seatEffortChannel } from '../runners/capabilities.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import { effortTokenOfModelId, type CliEffortChannel } from '../runners/effort-channel.js';
import { opencodeVariantChoices } from '../runners/variant-vocabulary.js';
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
  /** How this seat's effort intent reaches the tool it runs. */
  channel: CliEffortChannel;
  /** The effort level, the verbatim variant name, or the id-spelled token. */
  effortValue?: string | undefined;
  /** Whether a step can actually move this seat's effort: the channel has a ladder to walk. */
  effortEditable: boolean;
}>;

export type CrewSeat =
  | (CrewSeatRunner & Readonly<{ id: 'plan'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'build'; label: string }>)
  | (CrewSeatRunner & Readonly<{ id: 'review'; label: string; source: 'configured' | 'planner' }>);

function effortValueOf(
  runner: RunnerConfig,
  channel: CliEffortChannel,
  effort: EffortLevel | undefined,
): string | undefined {
  switch (channel) {
    case 'effort-flag':
      return effort;
    case 'variant':
      return 'variant' in runner ? runner.variant : undefined;
    case 'model-id':
      return effortTokenOfModelId('model' in runner ? runner.model : undefined);
    case 'none':
      return undefined;
    default:
      return assertNever(channel);
  }
}

/**
 * A variant channel delivers only the presets its own catalog spells, so a seat whose
 * model has no vocabulary here has nothing to step through — which is every kilo seat:
 * kilo publishes its presets per model, and only the picker reads that catalog.
 */
function effortEditableOf(runner: RunnerConfig, channel: CliEffortChannel): boolean {
  switch (channel) {
    case 'effort-flag':
      return true;
    case 'variant':
      return opencodeVariantChoices(runner).length > 0;
    case 'model-id':
    case 'none':
      return false;
    default:
      return assertNever(channel);
  }
}

function seatRunner(
  runner: RunnerConfig,
  id: CrewSeatId,
  displayName?: string | undefined,
): CrewSeatRunner {
  const role = CREW_SEAT_ROLES[id];
  const channel = seatEffortChannel({ runner, role });
  const effort = channel === 'effort-flag' && 'effort' in runner ? runner.effort : undefined;
  const effortValue = effortValueOf(runner, channel, effort);
  return {
    runner,
    model: formatSeatIdentity(runner, displayName),
    posture: runnerBillingPosture(runner),
    channel,
    ...(effortValue !== undefined && { effortValue }),
    effortEditable: effortEditableOf(runner, channel),
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
      ...seatRunner(config.planner, 'plan', displayNames?.plan),
    },
    {
      id: 'build',
      label: CREW_SEAT_LABELS.build,
      ...seatRunner(implementer, 'build', displayNames?.build),
    },
    {
      id: 'review',
      label: CREW_SEAT_LABELS.review,
      source: reviewer.source,
      ...seatRunner(
        reviewer.runner,
        'review',
        displayNames?.review ?? (reviewer.source === 'planner' ? displayNames?.plan : undefined),
      ),
    },
  ];
}
