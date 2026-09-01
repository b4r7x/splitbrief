import type { Config } from '../core/schemas/config.js';
import type {
  AgentPlannerConfig,
  ApiPlannerConfig,
  CliPlannerConfig,
  ShellPlannerConfig,
} from '../core/schemas/planner-config.js';
import type {
  AgentImplementerConfig,
  ApiImplementerConfig,
  ShellImplementerConfig,
} from '../core/schemas/implementer-config.js';
import { configError } from '../core/config/errors.js';

export function assertPlannerKind(config: Config, kind: 'api'): ApiPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'cli'): CliPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'shell'): ShellPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'agent'): AgentPlannerConfig;
export function assertPlannerKind(
  config: Config,
  kind: Config['planner']['kind'],
): Config['planner'] {
  if (config.planner.kind !== kind) throw configError.kindMismatch('planner', kind);
  return config.planner;
}

export function assertImplementerKind(config: Config, kind: 'api'): ApiImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'shell'): ShellImplementerConfig;
export function assertImplementerKind(config: Config, kind: 'agent'): AgentImplementerConfig;
export function assertImplementerKind(
  config: Config,
  kind: Config['implementer']['kind'],
): Config['implementer'] {
  if (config.implementer.kind !== kind) throw configError.kindMismatch('implementer', kind);
  return config.implementer;
}
