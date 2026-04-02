import { useMemo } from 'react';
import { loadConfig } from '../core/config.js';
import type { Config, PlannerTool } from '../types.js';

interface ConfigOverrides {
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
}

export function useConfig(projectDir: string, overrides: ConfigOverrides): Config {
  return useMemo(() => {
    const config = loadConfig(projectDir);
    if (overrides.modelOverride) config.implementer.model = overrides.modelOverride;
    if (overrides.providerOverride) config.implementer.provider = overrides.providerOverride;
    if (overrides.contextLengthOverride) config.implementer.contextLength = overrides.contextLengthOverride;
    if (overrides.plannerOverride) config.planner.tool = overrides.plannerOverride as PlannerTool;
    if (overrides.plannerModelOverride) config.planner.model = overrides.plannerModelOverride;
    return config;
  }, [projectDir, overrides.modelOverride, overrides.providerOverride, overrides.contextLengthOverride, overrides.plannerOverride, overrides.plannerModelOverride]);
}
