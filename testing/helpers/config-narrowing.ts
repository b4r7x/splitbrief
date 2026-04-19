import type {
  ImplementerConfig,
  CliImplementerConfig,
  ApiImplementerConfig,
  ShellImplementerConfig,
  AgentImplementerConfig,
  AgentSdkImplementerConfig,
} from '../../src/core/schemas/implementer-config.js';
import type {
  PlannerConfig,
  CliPlannerConfig,
  ApiPlannerConfig,
  ShellPlannerConfig,
  AgentPlannerConfig,
  AgentSdkPlannerConfig,
} from '../../src/core/schemas/planner-config.js';

type RunnerConfig = ImplementerConfig | PlannerConfig;

/**
 * Narrow a runner config to the `cli` variant, throwing if it isn't.
 *
 * Use these `expect*` helpers in tests instead of `as any` casts to narrow a
 * union-typed config by its `kind` discriminator.
 */
export function expectCli<T extends RunnerConfig>(config: T): Extract<T, { kind: 'cli' }> {
  if (config.kind !== 'cli') {
    throw new Error(`Expected cli-kind config, got kind='${config.kind}'`);
  }
  return config as Extract<T, { kind: 'cli' }>;
}

export function expectApi<T extends RunnerConfig>(config: T): Extract<T, { kind: 'api' }> {
  if (config.kind !== 'api') {
    throw new Error(`Expected api-kind config, got kind='${config.kind}'`);
  }
  return config as Extract<T, { kind: 'api' }>;
}

export function expectShell<T extends RunnerConfig>(config: T): Extract<T, { kind: 'shell' }> {
  if (config.kind !== 'shell') {
    throw new Error(`Expected shell-kind config, got kind='${config.kind}'`);
  }
  return config as Extract<T, { kind: 'shell' }>;
}

export function expectAgent<T extends RunnerConfig>(config: T): Extract<T, { kind: 'agent' }> {
  if (config.kind !== 'agent') {
    throw new Error(`Expected agent-kind config, got kind='${config.kind}'`);
  }
  return config as Extract<T, { kind: 'agent' }>;
}

export function expectAgentSdk<T extends RunnerConfig>(config: T): Extract<T, { kind: 'agent-sdk' }> {
  if (config.kind !== 'agent-sdk') {
    throw new Error(`Expected agent-sdk-kind config, got kind='${config.kind}'`);
  }
  return config as Extract<T, { kind: 'agent-sdk' }>;
}

// Re-exported narrowed types for ergonomic imports in tests.
export type {
  CliImplementerConfig,
  ApiImplementerConfig,
  ShellImplementerConfig,
  AgentImplementerConfig,
  AgentSdkImplementerConfig,
  CliPlannerConfig,
  ApiPlannerConfig,
  ShellPlannerConfig,
  AgentPlannerConfig,
  AgentSdkPlannerConfig,
};
