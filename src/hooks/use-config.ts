import { loadConfig } from '../config.js';
import type { Config } from '../types.js';

interface ConfigOverrides {
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
}

export function useConfig(projectDir: string, overrides: ConfigOverrides): Config {
  const config = loadConfig(projectDir);
  if (overrides.modelOverride) config.implementer.model = overrides.modelOverride;
  if (overrides.providerOverride) config.implementer.provider = overrides.providerOverride;
  if (overrides.contextLengthOverride) config.implementer.contextLength = overrides.contextLengthOverride;
  if (overrides.plannerOverride) (config.planner as any).tool = overrides.plannerOverride;
  if (overrides.plannerModelOverride) (config.planner as any).model = overrides.plannerModelOverride;
  return config;
}
