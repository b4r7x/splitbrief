import type { Config } from '../../types.js';
import type { Planner } from './types.js';
import { createCommandBasedPlanner } from './command-invoke.js';
import { assertPlannerKind } from './utils.js';

export function createShellPlanner(config: Config): Planner {
  return createCommandBasedPlanner(assertPlannerKind(config, 'shell'), 'Shell planner');
}
