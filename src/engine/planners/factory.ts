import type { Config } from '../../types.js';
import type { Planner } from './types.js';
import { createBackend } from '../../utils/backend-factory.js';

export async function createPlanner(config: Config): Promise<Planner> {
  const planner = config.planner;

  const registry: Record<string, () => Promise<Planner>> = {
    cli: async () => {
      if (planner.kind !== 'cli') throw new Error('unreachable');
      if (planner.tool === 'claude-code') {
        const { createClaudeCodePlanner } = await import('./claude-code.js');
        return createClaudeCodePlanner(planner.model);
      }
      const { createCliPlanner } = await import('./cli.js');
      return createCliPlanner(planner.tool, planner.model);
    },
    'agent-sdk': async () => {
      if (planner.kind !== 'agent-sdk') throw new Error('unreachable');
      const { createAgentSdkPlanner } = await import('./agent-sdk.js');
      return createAgentSdkPlanner(planner.model);
    },
    shell: async () => {
      const { createShellPlanner } = await import('./shell.js');
      return createShellPlanner(config);
    },
    api: async () => {
      if (planner.kind !== 'api') throw new Error('unreachable');
      const { createApiPlanner } = await import('./api.js');
      return createApiPlanner(config);
    },
  };

  return createBackend(planner.kind, registry, 'planner kind');
}
