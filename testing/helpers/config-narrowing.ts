import type { ImplementerConfig } from '../../src/core/schemas/runner/implementer.js';
import type { PlannerConfig } from '../../src/core/schemas/runner/planner.js';

type RunnerConfig = ImplementerConfig | PlannerConfig;

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
