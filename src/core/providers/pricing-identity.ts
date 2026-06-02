import type { Config } from '../schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';

export interface PricingIdentity {
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
}

export function runPricingIdentity(config: Config): PricingIdentity {
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = getRunnerModelName(config.implementer);
  return {
    plannerTool: getRunnerDisplayName(config.planner),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
  };
}
