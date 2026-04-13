import type { Config } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { createCommandPlannerInvoke } from './command-invoke.js';

export function createShellPlanner(config: Config): Planner {
  if (config.planner.kind !== 'shell') {
    throw new Error(`createShellPlanner requires planner.kind = 'shell' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const command = plannerCfg.command;

  const invoke = createCommandPlannerInvoke({
    command,
    args: plannerCfg.args ?? [],
    outputFormat: plannerCfg.outputFormat ?? 'text',
    extractsCode: true,
    notFoundMessage: `Shell planner command not found: ${command}`,
  });

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    hintSuccessMode: 'files',
    ...createCommandAvailability(command),
  });
}
