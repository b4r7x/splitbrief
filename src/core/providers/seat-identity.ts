import type { Config } from '../schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { configuredReviewerSeat } from '../config/accessors/reviewer-seat.js';
import type { RunnerKind } from '../schemas/enums.js';
import { seatAxisWords } from '../runners/effort-channel.js';

export interface SeatIdentity {
  plannerTool: string;
  plannerModel?: string | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  plannerKind?: RunnerKind | undefined;
  /** The axis words the seat ran at; a record written before they were kept has none. */
  plannerAxes?: readonly string[] | undefined;
  implementerTool: string;
  implementerModel?: string | undefined;
  /** The backend the seat ran on; a record written before kinds were kept has none. */
  implementerKind?: RunnerKind | undefined;
  implementerAxes?: readonly string[] | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
  reviewerKind?: RunnerKind | undefined;
  reviewerAxes?: readonly string[] | undefined;
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
    plannerAxes: seatAxisWords(config.planner),
    implementerTool: getRunnerDisplayName(implementer),
    ...(implementerModel !== undefined && { implementerModel }),
    implementerKind: implementer.kind,
    implementerAxes: seatAxisWords(implementer),
    ...(reviewer !== undefined && {
      reviewerTool: reviewer.tool,
      ...(reviewer.model !== undefined && { reviewerModel: reviewer.model }),
      reviewerKind: reviewer.kind,
      reviewerAxes: reviewer.axes,
    }),
  };
}
