import type { Config } from '../../types.js';
import type {
  AgentPlannerConfig,
  AgentSdkPlannerConfig,
  ApiPlannerConfig,
  CliPlannerConfig,
  ShellPlannerConfig,
} from '../../core/types/schemas/planner-config.js';

export function assertPlannerKind(config: Config, kind: 'api'): ApiPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'cli'): CliPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'shell'): ShellPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'agent'): AgentPlannerConfig;
export function assertPlannerKind(config: Config, kind: 'agent-sdk'): AgentSdkPlannerConfig;
export function assertPlannerKind(
  config: Config,
  kind: Config['planner']['kind'],
): Config['planner'] {
  if (config.planner.kind !== kind) {
    throw new Error(`Expected ${kind} planner config`);
  }
  return config.planner;
}
