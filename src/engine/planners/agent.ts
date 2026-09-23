import type { Config } from '../../core/schemas/config.js';
import type { Planner } from './types.js';
import { createCommandBasedPlanner, resolveCapabilities } from './command-invoke.js';
import { assertPlannerKind } from '../config-assertions.js';

export function createAgentPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'agent');

  return createCommandBasedPlanner(plannerCfg, 'Agent planner', {
    notFoundMessage: `Agent planner command not found: ${plannerCfg.command}`,
    escalateFullMode: 'files',
    capabilities: resolveCapabilities(plannerCfg.capabilities),
  });
}
