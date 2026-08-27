import {
  resolveImplementerProfiles,
  updateDefaultImplementerConfig,
} from './implementer-profiles.js';
import { resolveReviewerRunner } from './reviewer-runner.js';
import type { ActiveRunnerRole } from '../../runners/cli-tool-catalog.js';
import type { Config } from '../../schemas/config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import { createOpaqueIdFactory } from '../../../utils/opaque-id.js';

export type ActiveRunnerConfig = PlannerConfig | ImplementerConfig;

export interface ActiveRunnerLens {
  readonly runner: ActiveRunnerConfig;
  readonly sourceNodeId: string;
}

interface ActiveRunnerSource {
  readonly runner: ActiveRunnerConfig;
  readonly sourceNode: object;
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

const sourceNodeId = createOpaqueIdFactory('active-runner-source');

function resolveActiveRunnerSource(input: ReadActiveRunnerInput): ActiveRunnerSource {
  if (input.role === 'planner') {
    return {
      runner: input.config.planner,
      sourceNode: input.config.planner,
    };
  }

  if (input.role === 'reviewer') {
    const reviewer = resolveReviewerRunner(input.config).runner;
    return { runner: reviewer, sourceNode: reviewer };
  }

  const resolved = resolveImplementerProfiles(input.config);
  const sourceNode =
    input.config.implementerProfiles?.profiles[resolved.defaultProfile.name] ??
    input.config.implementer;
  return {
    runner: resolved.defaultProfile.config,
    sourceNode,
  };
}

export function readActiveRunnerLens(input: ReadActiveRunnerInput): ActiveRunnerLens {
  const activeRunner = resolveActiveRunnerSource(input);
  return {
    runner: activeRunner.runner,
    sourceNodeId: sourceNodeId(activeRunner.sourceNode),
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
