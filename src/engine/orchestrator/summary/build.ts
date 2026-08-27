import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Summary, CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { calculateCostBreakdown } from '../../providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { formatCost } from '../../../core/formatting.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../../core/state/selectors.js';
import { projectCostPredictionForTranscriptPolicy } from '../../events/protection/protect.js';
import { featureForTranscriptPolicy } from '../../../core/sessions/session-id.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';
import { reconcileTokenUsageWithSessionLog } from './usage-reconcile.js';
import {
  applyTaskBreakdownCosts,
  countLocalAndEscalatedTasks,
  projectTaskBreakdownForTranscriptPolicy,
  type BuildSummaryState,
} from './task-metrics.js';

export type { BuildSummaryState };

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
  persistTranscript?: boolean | undefined;
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
    persistTranscript = true,
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

  const costBreakdown = calculateCostBreakdown(
    {
      tokenUsage,
      totalTasks,
      escalatedCount: escalatedToPlanner,
      completedLocalTasks: completedByLocal,
      plannerTool,
      implementerTool,
      plannerModel,
      implementerModel,
      ...(reviewerTool !== undefined && { reviewerTool }),
      ...(reviewerModel !== undefined && { reviewerModel }),
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
    plannerTool,
    implementerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    pricingCache,
  });

  const taskBreakdown = persistTranscript
    ? costedBreakdowns
    : costedBreakdowns?.map(projectTaskBreakdownForTranscriptPolicy);

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
    feature: featureForTranscriptPolicy(feature, persistTranscript),
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown,
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
    ...(costPrediction !== undefined && {
      costPrediction: projectCostPredictionForTranscriptPolicy(costPrediction, persistTranscript),
    }),
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
  };
}
