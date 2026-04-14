import type { Config } from '../../types.js';
import type { Planner, PlannerCapabilities } from './types.js';
import { createCommandBasedPlanner } from './command-invoke.js';
import { assertPlannerKind } from './utils.js';

export function createShellPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'shell');
  const override = plannerCfg.capabilities ?? {};
  const capabilities: PlannerCapabilities = {
    supportsConversationalPlanning: override.supportsConversationalPlanning ?? false,
    supportsHintEscalation: override.supportsHintEscalation ?? false,
    supportsSessionResume: override.supportsSessionResume ?? false,
    supportsMidStreamInjection: override.supportsMidStreamInjection ?? false,
  };
  return createCommandBasedPlanner(plannerCfg, 'Shell planner', { capabilities });
}
