import type { Config } from '../schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { configuredReviewerSeat } from '../config/accessors/reviewer-seat.js';

export interface PricingIdentity {
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
}

export function runPricingIdentity(config: Config): PricingIdentity {
  const plannerModel = getRunnerModelName(config.planner);
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const implementerModel = getRunnerModelName(implementer);
  const reviewer = configuredReviewerSeat(config);
  return {
    plannerTool: getRunnerDisplayName(config.planner),
    implementerTool: getRunnerDisplayName(implementer),
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
    ...(reviewer !== undefined && {
      reviewerTool: reviewer.tool,
      ...(reviewer.model !== undefined && { reviewerModel: reviewer.model }),
    }),
  };
}
