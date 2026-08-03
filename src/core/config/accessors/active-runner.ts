import {
  resolveImplementerProfiles,
  updateDefaultImplementerConfig,
} from './implementer-profiles.js';
import type { Config } from '../../schemas/config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';

export type ActiveRunnerRole = 'planner' | 'implementer';
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
    };

const sourceNodeIds = new WeakMap<object, string>();
let nextSourceNodeId = 1;

function sourceNodeId(sourceNode: object): string {
  const existing = sourceNodeIds.get(sourceNode);
  if (existing !== undefined) return existing;

  const id = `active-runner-source-${nextSourceNodeId}`;
  nextSourceNodeId += 1;
  sourceNodeIds.set(sourceNode, id);
  return id;
}

function resolveActiveRunnerSource(input: ReadActiveRunnerInput): ActiveRunnerSource {
  if (input.role === 'planner') {
    return {
      runner: input.config.planner,
      sourceNode: input.config.planner,
    };
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

  return updateDefaultImplementerConfig(input.config, input.updater);
}
