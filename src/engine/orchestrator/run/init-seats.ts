import type { Config } from '../../../core/schemas/config.js';
import { configuredReviewerSeat } from '../../../core/config/accessors/reviewer-seat.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../../implementers/types.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { createPlanner, createImplementer, createReviewer } from '../../runners/factory.js';
import type { EventBus } from '../../events/types.js';
import { createImplementerPublisher } from '../events.js';
import { configForProfile } from '../task/routing.js';

type SeatBase = {
  config: Config;
  prepared: PreparedExecution;
  customRuntime: CustomRunnerRuntimePort;
};

export type PlannerSeatInput = SeatBase & {
  projectDir: string;
  initialSessionId: string | null;
  injectedPlanner: Planner | undefined;
  injectedReviewer: Reviewer | undefined;
};

export type PlannerSeat = {
  planner: Planner;
  reviewer: Reviewer;
  reviewerSeat: ReturnType<typeof configuredReviewerSeat>;
};

/** Builds the planner and reviewer seats; with no configured reviewer the planner holds the review seat. */
export async function createPlannerSeat(input: PlannerSeatInput): Promise<PlannerSeat> {
  const { config, prepared, customRuntime } = input;
  const planner =
    input.injectedPlanner ??
    (await createPlanner(config, {
      initialSessionId: input.initialSessionId,
      projectDir: input.projectDir,
      preparedConfig: prepared.config,
      preparationId: prepared.preparationId,
      gates: prepared.gates,
      slot: { role: 'planner' },
      customRuntime,
    }));
  const reviewerSeat = configuredReviewerSeat(config);
  const reviewer: Reviewer =
    input.injectedReviewer ??
    (reviewerSeat === undefined
      ? planner
      : await createReviewer(config, {
          preparedConfig: prepared.config,
          preparationId: prepared.preparationId,
          gates: prepared.gates,
          slot: { role: 'reviewer' },
          customRuntime,
        }));
  return { planner, reviewer, reviewerSeat };
}

export type ImplementerSeatInput = SeatBase & {
  bus: EventBus;
  allowRepoRunners: boolean;
  injectedImplementer: Implementer | undefined;
};

export type ImplementerSeat = {
  implementer: Implementer;
  createPreparedImplementer: (
    runnerConfig: Config,
    factoryOptions?: ImplementerFactoryOptions,
  ) => Promise<Implementer>;
};

/** Builds the default implementer seat plus the factory the workflow uses for per-profile implementers. */
export async function createImplementerSeat(input: ImplementerSeatInput): Promise<ImplementerSeat> {
  const { config, prepared, customRuntime } = input;
  const resolvedDefaultProfile = resolveImplementerProfiles(config).defaultProfile;
  const defaultProfile = resolvedDefaultProfile.name;
  const createPreparedImplementer = async (
    runnerConfig: Config,
    factoryOptions: ImplementerFactoryOptions = {},
  ): Promise<Implementer> => {
    const slot = factoryOptions.slot ?? { role: 'implementer', profile: defaultProfile };
    return createImplementer(config, {
      ...factoryOptions,
      customRuntime,
      preparedConfig: prepared.config,
      preparationId: prepared.preparationId,
      gates: prepared.gates,
      slot,
      ...(slot.role === 'intermediate' &&
        runnerConfig.implementer.contextLength !== undefined && {
          intermediateContextLength: runnerConfig.implementer.contextLength,
        }),
    });
  };
  const implementer =
    input.injectedImplementer ??
    (await createPreparedImplementer(configForProfile(config, resolvedDefaultProfile), {
      publisher: createImplementerPublisher(input.bus),
      allowRepoRunners: input.allowRepoRunners,
      slot: { role: 'implementer', profile: defaultProfile },
    }));
  return { implementer, createPreparedImplementer };
}
