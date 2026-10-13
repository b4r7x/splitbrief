import {
  resolveImplementerProfiles,
  updateDefaultImplementerConfig,
} from './implementer-profiles.js';
import { resolveReviewerRunner } from './reviewer-runner.js';
import type { ActiveRunnerRole } from '../../runners/seat-roles.js';
import type { Config } from '../../schemas/config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import { contentIdentityId } from './content-identity.js';

export type ActiveRunnerConfig = PlannerConfig | ImplementerConfig;

export interface ActiveRunnerLens {
  readonly runner: ActiveRunnerConfig;
  readonly sourceNodeId: string;
}

interface ActiveRunnerSource {
  readonly runner: ActiveRunnerConfig;
  readonly sourcePath: string;
}

export interface ReadActiveRunnerInput {
  readonly config: Config;
  readonly role: ActiveRunnerRole;
}

export type UpdateActiveRunnerInput =
  | {
      readonly config: Config;
      readonly role: 'planner';
      readonly updater: (existing: PlannerConfig) => PlannerConfig;
    }
  | {
      readonly config: Config;
      readonly role: 'implementer';
      readonly updater: (existing: ImplementerConfig) => ImplementerConfig;
    }
  | {
      readonly config: Config;
      readonly role: 'reviewer';
      readonly updater: (existing: ReviewerConfig) => ReviewerConfig;
    };

function resolveActiveRunnerSource(input: ReadActiveRunnerInput): ActiveRunnerSource {
  if (input.role === 'planner') {
    return {
      runner: input.config.planner,
      sourcePath: 'planner',
    };
  }

  if (input.role === 'reviewer') {
    const reviewer = resolveReviewerRunner(input.config);
    return {
      runner: reviewer.runner,
      sourcePath: reviewer.source === 'planner' ? 'planner' : 'reviewer',
    };
  }

  const resolved = resolveImplementerProfiles(input.config);
  const sourcePath =
    input.config.implementerProfiles?.profiles[resolved.defaultProfile.name] === undefined
      ? 'implementer'
      : `implementerProfiles.profiles.${resolved.defaultProfile.name}`;
  return {
    runner: resolved.defaultProfile.config,
    sourcePath,
  };
}

export function readActiveRunnerLens(input: ReadActiveRunnerInput): ActiveRunnerLens {
  const activeRunner = resolveActiveRunnerSource(input);
  return {
    runner: activeRunner.runner,
    sourceNodeId: contentIdentityId('active-runner-source', {
      path: activeRunner.sourcePath,
      ...(activeRunner.runner.kind === 'api' && { apiKey: activeRunner.runner.apiKey }),
    }),
  };
}

export function readActiveRunner(input: ReadActiveRunnerInput): ActiveRunnerConfig {
  return resolveActiveRunnerSource(input).runner;
}

export function updateActiveRunner(input: UpdateActiveRunnerInput): Config {
  if (input.role === 'planner') {
    return { ...input.config, planner: input.updater(input.config.planner) };
  }

  if (input.role === 'reviewer') {
    return {
      ...input.config,
      reviewer: input.updater(resolveReviewerRunner(input.config).runner),
    };
  }

  return updateDefaultImplementerConfig(input.config, input.updater);
}

export function clearReviewerSeat(config: Config): Config {
  const { reviewer: _reviewer, ...rest } = config;
  return rest;
}
