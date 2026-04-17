import type { Config } from '../../types.js';
import type { Planner } from './types.js';
import { createCommandBasedPlanner, resolveCapabilities } from './command-invoke.js';
import { assertPlannerKind } from '../config-assertions.js';

export function createShellPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'shell');
  return createCommandBasedPlanner(plannerCfg, 'Shell planner', { capabilities: resolveCapabilities(plannerCfg.capabilities) });
}
