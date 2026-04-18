import type { Config } from '../core/types/config-options.js';
import type {
  AgentPlannerConfig,
  AgentSdkPlannerConfig,
  ApiPlannerConfig,
  CliPlannerConfig,
  ShellPlannerConfig,
} from '../core/schemas/planner-config.js';
import type {
  AgentImplementerConfig,
  AgentSdkImplementerConfig,
  ApiImplementerConfig,
  ShellImplementerConfig,
} from '../core/schemas/implementer-config.js';

function expectedConfigKind(role: 'planner' | 'implementer', kind: string): Error {
  return new Error(`Expected ${kind} ${role} config`);
}

export function assertPlannerKind(config: Config, kind: 'api'): ApiPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'cli'): CliPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'shell'): ShellPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'agent'): AgentPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'agent-sdk'): AgentSdkPlannerConfig;
export function assertPlannerKind(
  config: Config,
  kind: Config['planner']['kind'],
): Config['planner'] {
  if (config.planner.kind !== kind) throw expectedConfigKind('planner', kind);
  return config.planner;
}

export function assertImplementerKind(config: Config, kind: 'api'): ApiImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'shell'): ShellImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'agent'): AgentImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'agent-sdk'): AgentSdkImplementerConfig;
export function assertImplementerKind(
  config: Config,
  kind: Config['implementer']['kind'],
): Config['implementer'] {
  if (config.implementer.kind !== kind) throw expectedConfigKind('implementer', kind);
  return config.implementer;
}
