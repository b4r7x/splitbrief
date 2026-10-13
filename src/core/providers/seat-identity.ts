import type { Config } from '../schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { configuredReviewerSeat } from '../config/accessors/reviewer-seat.js';
import type { RunnerKind } from '../schemas/enums.js';
import { seatIdsOf } from '../crew/identity.js';
import type { SpecMetadata } from '../paths-io.js';

export function specMetadataOf(config: Config): SpecMetadata {
  return {
    planner: seatIdsOf(config.planner),
    implementer: seatIdsOf(resolveImplementerProfiles(config).defaultProfile.config),
  };
}

export interface SeatIdentity {
  plannerTool: string;
  plannerModel?: string | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  plannerKind?: RunnerKind | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  implementerKind?: RunnerKind | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
  reviewerKind?: RunnerKind | undefined;
}

export function runSeatIdentity(config: Config): SeatIdentity {
  const plannerModel = getRunnerModelName(config.planner);
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const implementerModel = getRunnerModelName(implementer);
  const reviewer = configuredReviewerSeat(config);
  return {
    plannerTool: getRunnerDisplayName(config.planner),
    ...(plannerModel !== undefined && { plannerModel }),
    plannerKind: config.planner.kind,
    implementerTool: getRunnerDisplayName(implementer),
    ...(implementerModel !== undefined && { implementerModel }),
    implementerKind: implementer.kind,
    ...(reviewer !== undefined && {
      reviewerTool: reviewer.tool,
      ...(reviewer.model !== undefined && { reviewerModel: reviewer.model }),
      reviewerKind: reviewer.kind,
    }),
  };
}
