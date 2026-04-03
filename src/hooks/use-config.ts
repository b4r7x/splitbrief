import { useMemo, useState } from 'react';
import { loadConfig } from '../core/config.js';
import type { Config, PlannerTool } from '../types.js';

interface ConfigOverrides {
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
}

export function useConfig(projectDir: string, overrides: ConfigOverrides): { config: Config; reloadConfig: () => void } {
  const [version, setVersion] = useState(0);

  const config = useMemo(() => {
    void version;
    const cfg = loadConfig(projectDir);
    if (overrides.modelOverride) cfg.implementer.model = overrides.modelOverride;
    if (overrides.providerOverride) cfg.implementer.provider = overrides.providerOverride;
    if (overrides.contextLengthOverride) cfg.implementer.contextLength = overrides.contextLengthOverride;
    if (overrides.plannerOverride) cfg.planner.tool = overrides.plannerOverride as PlannerTool;
    if (overrides.plannerModelOverride) cfg.planner.model = overrides.plannerModelOverride;
    return cfg;
  }, [projectDir, version, overrides.modelOverride, overrides.providerOverride, overrides.contextLengthOverride, overrides.plannerOverride, overrides.plannerModelOverride]);

  const reloadConfig = () => setVersion(v => v + 1);

  return { config, reloadConfig };
}
