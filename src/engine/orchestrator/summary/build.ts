import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Summary, CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { calculateCostBreakdown } from '../../providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { formatCost } from '../../../core/formatting.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../../core/state/selectors.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';
import { reconcileTokenUsageWithSessionLog } from './usage-reconcile.js';
import {
  applyTaskBreakdownCosts,
  countLocalAndEscalatedTasks,
  type BuildSummaryState,
} from './task-metrics.js';

export type { BuildSummaryState };

/**
 * The seat names here are the run's **display identity** — the seat it is on
 * now. A seat swap moves them; it does not move the spend already booked
 * against the seat that produced it, which `buildSummary` reads from the saved
 * state instead.
 */
export type SummaryBase = {
  feature: string;
  startTime: number;
  plannerTool: string;
  plannerModel?: string;
  implementerTool: string;
  implementerModel?: string;
  reviewerTool?: string;
  reviewerModel?: string;
  mode?: WorkflowMode;
  projectDir?: string;
  sessionId?: string;
  costPrediction?: CostPrediction | undefined;
  pricingCache?: ModelCacheAccessor | undefined;
};

type BuildSummaryOptions = SummaryBase & {
  state: BuildSummaryState;
  taskBreakdowns?: TaskTokenUsage[];
  phaseTimings?: Record<string, number>;
};

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const {
    feature,
    state,
    startTime,
    taskBreakdowns,
    plannerTool,
    plannerModel,
    implementerTool,
    implementerModel,
    reviewerTool,
    reviewerModel,
    phaseTimings,
    mode,
    projectDir,
    sessionId,
    costPrediction,
    pricingCache,
  } = opts;
  const totalTasks = state.tasks.length;
  const completionCounts = countLocalAndEscalatedTasks(state, taskBreakdowns);
  const completedByLocal = completionCounts.local;
  const escalatedToPlanner = completionCounts.escalated;
  const skipped = getSkippedTaskIds(state).length;
  const failed = getFailedTaskIds(state).length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;
  const tokenUsage =
    projectDir && sessionId
      ? reconcileTokenUsageWithSessionLog({
          ref: { projectDir, sessionId },
          booked: state.tokenUsage,
        })
      : state.tokenUsage;

  // Spend is attributed to the seat that spent it. The saved state records that
  // seat at the run's start and a seat swap never rewrites it, so a run that
  // changed tools mid-flight is still costed against the tool it was on when
  // the tokens were booked, while the summary it returns names the seat in use.
  const plannerSpentTool = state.plannerTool ?? plannerTool;
  const plannerSpentModel = state.plannerTool === undefined ? plannerModel : state.plannerModel;
  const implementerSpentTool = state.implementerTool ?? implementerTool;
  const implementerSpentModel =
    state.implementerTool === undefined ? implementerModel : state.implementerModel;
  const reviewerSpentTool = state.reviewerTool ?? reviewerTool;
  const reviewerSpentModel = state.reviewerTool === undefined ? reviewerModel : state.reviewerModel;

  const costBreakdown = calculateCostBreakdown(
    {
      tokenUsage,
      totalTasks,
      escalatedCount: escalatedToPlanner,
      completedLocalTasks: completedByLocal,
      plannerTool: plannerSpentTool,
      implementerTool: implementerSpentTool,
      plannerModel: plannerSpentModel,
      implementerModel: implementerSpentModel,
      ...(reviewerSpentTool !== undefined && { reviewerTool: reviewerSpentTool }),
      ...(reviewerSpentModel !== undefined && { reviewerModel: reviewerSpentModel }),
      taskBreakdowns,
    },
    pricingCache,
  );
  const estimatedCostSavings = costBreakdown.hasSavingsEstimate
    ? formatCost(costBreakdown.savingsAmount)
    : 'unavailable';

  const costedBreakdowns = applyTaskBreakdownCosts({
    state,
    taskBreakdowns,
    plannerTool: plannerSpentTool,
    implementerTool: implementerSpentTool,
    ...(plannerSpentModel !== undefined && { plannerModel: plannerSpentModel }),
    ...(implementerSpentModel !== undefined && { implementerModel: implementerSpentModel }),
    ...(reviewerSpentTool !== undefined && { reviewerTool: reviewerSpentTool }),
    pricingCache,
  });

  let evidenceSummary: Summary['evidenceSummary'];
  let briefQuality: Summary['briefQuality'];
  let driftSummary: Summary['driftSummary'];
  let chainDriftSummary: Summary['chainDriftSummary'];
  let checkpointSummary: Summary['checkpointSummary'];
  let reviewPacket: Summary['reviewPacket'];
  if (projectDir && sessionId) {
    const rollups = loadSessionArtifactRollups(projectDir, sessionId);
    evidenceSummary = rollups.evidenceSummary;
    briefQuality = rollups.briefQuality;
    driftSummary = rollups.driftSummary;
    chainDriftSummary = rollups.chainDriftSummary;
    checkpointSummary = rollups.checkpointSummary;
    reviewPacket = rollups.reviewPacket;
  }

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown: costedBreakdowns,
    costBreakdown,
    plannerTool,
    plannerModel,
    implementerTool,
    implementerModel,
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    phaseTimings,
    ...(mode !== undefined && { mode }),
    ...(evidenceSummary && { evidenceSummary }),
    ...(briefQuality && { briefQuality }),
    ...(driftSummary && { driftSummary }),
    ...(chainDriftSummary && { chainDriftSummary }),
    ...(costPrediction !== undefined && { costPrediction }),
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
  };
}
