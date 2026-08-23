import type { z } from 'zod';
import {
  costKnownFlags,
  type CostBreakdown,
  type ReviewVerdictSchema,
  type Summary,
} from '../src/core/schemas/summary.js';
import { totalInputTokens, totalOutputTokens } from '../src/core/schemas/tokens.js';
import { splitSeatTokenTotals } from '../src/core/providers/seat-totals.js';
import { classifyTaskCompletionMethod } from '../src/core/task-completion.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import type { QualityCheckResult } from './scenarios/types.js';

export type OutcomeMetrics = {
  totalTasks: number;
  firstPassTasks: number;
  firstPassRate: number;
  retriedTasks: number;
  /** Tasks an escalation carried to completion, as the run summary counted them. */
  escalatedTasks: number;
  /** Times the run escalated, counted from the `escalate` events; an attempt that failed still counts. */
  escalationAttempts: number;
  failedTasks: number;
  skippedTasks: number;
  retryAttempts: number;
};

export type ReviewMetrics = {
  verdict: z.infer<typeof ReviewVerdictSchema> | null;
  criticalFindings: number;
  warningFindings: number;
  noteFindings: number;
  validationGreen: boolean;
};

export type GreenRunAggregates = {
  greenRunsWithFindings: number;
  greenRunsCriticalFindings: number;
};

export type QualityScore = {
  totalChecks: number;
  passedChecks: number;
  failedChecks: string[];
  score: number;
};

export type CostMetrics = {
  plannerInputTokens: number;
  plannerOutputTokens: number;
  implementerInputTokens: number;
  implementerOutputTokens: number;
  escalationInputTokens: number;
  escalationOutputTokens: number;
  reviewerInputTokens: number;
  reviewerOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
  costBreakdown: CostBreakdown | null;
  pricingAvailable: boolean;
};

export type RunMetrics = {
  scenarioId: string;
  mode: 'baseline' | 'routed';
  durationMs: number;
  sessionArtifactsDir: string | null;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  escalatedTasks: number;
  skippedTasks: number;
  retryCount: number;
  quality: QualityScore;
  cost: CostMetrics;
  testsPassedAfterRun: boolean;
  outcome: OutcomeMetrics;
  review: ReviewMetrics;
};

export type ScenarioComparison = {
  scenarioId: string;
  scenarioName: string;
  baseline: RunMetrics;
  routed: RunMetrics;
  costSavingsPercent: number;
  qualityRetentionPercent: number;
  baselineCostUSD: number;
  routedCostUSD: number;
  savingsUSD: number;
  firstPassRateDeltaPercent: number;
};

export type EvalReport = {
  timestamp: string;
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  scenarios: ScenarioComparison[];
  aggregate: {
    /** Average over the pairs priced on both sides; `null` when no pair was. */
    avgCostSavingsPercent: number | null;
    avgQualityRetentionPercent: number;
    /** Sum over the priced baseline runs; `null` when none of them was priced. */
    totalBaselineCostUSD: number | null;
    /** Sum over the priced routed runs; `null` when none of them was priced. */
    totalRoutedCostUSD: number | null;
    /** Sum over the pairs priced on both sides; `null` when no pair was. */
    totalSavingsUSD: number | null;
    scenariosRun: number;
    scenariosWhereRoutedMatchedBaseline: number;
    avgBaselineFirstPassRatePercent: number;
    avgRoutedFirstPassRatePercent: number;
    totalRetryAttempts: number;
    /** Escalation attempts across every run, from the `escalate` events. */
    totalEscalations: number;
    /** Tasks escalations carried to completion, from the run summaries. */
    totalEscalationCompletions: number;
    greenRunsWithFindings: number;
    greenRunsCriticalFindings: number;
  };
};

export function collectCostMetrics(summary: Summary): CostMetrics {
  const usage = summary.tokenUsage;
  const costBreakdown = summary.costBreakdown ?? null;
  const seats = splitSeatTokenTotals({ tokenUsage: usage, reviewerTool: summary.reviewerTool });
  return {
    plannerInputTokens: seats.planner.input,
    plannerOutputTokens: seats.planner.output,
    implementerInputTokens: usage.implementerInput,
    implementerOutputTokens: usage.implementerOutput,
    escalationInputTokens: usage.escalationInput,
    escalationOutputTokens: usage.escalationOutput,
    reviewerInputTokens: seats.reviewer?.input ?? 0,
    reviewerOutputTokens: seats.reviewer?.output ?? 0,
    totalInputTokens: totalInputTokens(usage),
    totalOutputTokens: totalOutputTokens(usage),
    estimatedCostUSD: costBreakdown?.totalActualCost ?? 0,
    costBreakdown,
    pricingAvailable:
      costBreakdown !== null &&
      costBreakdown.hasPricedUsage === true &&
      costKnownFlags(costBreakdown).totalCostKnown,
  };
}

export function collectQualityScore(results: QualityCheckResult[]): QualityScore {
  const passed = results.filter((result) => result.passed);
  const failed = results.filter((result) => !result.passed);
  return {
    totalChecks: results.length,
    passedChecks: passed.length,
    failedChecks: failed.map((result) => result.detail),
    score: results.length > 0 ? passed.length / results.length : 0,
  };
}

export function collectReviewMetrics(summary: Summary): ReviewMetrics {
  const packet = summary.reviewPacket;
  return {
    verdict: packet?.finalReviewVerdict ?? null,
    criticalFindings: packet?.finalReviewFindingCounts.critical ?? 0,
    warningFindings: packet?.finalReviewFindingCounts.warning ?? 0,
    noteFindings: packet?.finalReviewFindingCounts.note ?? 0,
    validationGreen: summary.failed === 0 && summary.skipped === 0,
  };
}

function collectOutcomeMetrics(
  summary: Summary,
  eventCounts: { retryAttempts: number; escalationAttempts: number },
): OutcomeMetrics {
  const breakdown = summary.taskBreakdown ?? [];
  const firstPassTasks = breakdown.filter(
    (entry) => classifyTaskCompletionMethod(entry.method) === 'local' && entry.retryCount === 0,
  ).length;
  const retriedTasks = breakdown.filter((entry) => entry.retryCount > 0).length;
  return {
    totalTasks: summary.totalTasks,
    firstPassTasks,
    firstPassRate: summary.totalTasks > 0 ? firstPassTasks / summary.totalTasks : 0,
    retriedTasks,
    escalatedTasks: summary.escalatedToPlanner,
    escalationAttempts: eventCounts.escalationAttempts,
    failedTasks: summary.failed,
    skippedTasks: summary.skipped,
    retryAttempts: eventCounts.retryAttempts,
  };
}

export function collectRunMetrics(
  scenarioId: string,
  mode: 'baseline' | 'routed',
  summary: Summary,
  events: EngineEvent[],
  qualityResults: QualityCheckResult[],
  durationMs: number,
  sessionArtifactsDir: string | null,
): RunMetrics {
  const retryEvents = events.filter((event) => event.type === 'task_retry');
  const escalateEvents = events.filter((event) => event.type === 'escalate');
  return {
    scenarioId,
    mode,
    durationMs,
    sessionArtifactsDir,
    taskCount: summary.totalTasks,
    completedTasks: summary.completedByLocal + summary.escalatedToPlanner,
    failedTasks: summary.failed,
    escalatedTasks: summary.escalatedToPlanner,
    skippedTasks: summary.skipped,
    retryCount: retryEvents.length,
    quality: collectQualityScore(qualityResults),
    cost: collectCostMetrics(summary),
    testsPassedAfterRun: qualityResults.every((result) => result.passed),
    outcome: collectOutcomeMetrics(summary, {
      retryAttempts: retryEvents.length,
      escalationAttempts: escalateEvents.length,
    }),
    review: collectReviewMetrics(summary),
  };
}

export function collectGreenRunAggregates(comparisons: ScenarioComparison[]): GreenRunAggregates {
  let greenRunsWithFindings = 0;
  let greenRunsCriticalFindings = 0;
  for (const comparison of comparisons) {
    for (const run of [comparison.baseline, comparison.routed]) {
      if (run.taskCount === 0 || !run.review.validationGreen) continue;
      const findings =
        run.review.criticalFindings + run.review.warningFindings + run.review.noteFindings;
      if (findings === 0) continue;
      greenRunsWithFindings += 1;
      greenRunsCriticalFindings += run.review.criticalFindings;
    }
  }
  return { greenRunsWithFindings, greenRunsCriticalFindings };
}

export function compareScenario(
  scenarioId: string,
  scenarioName: string,
  baseline: RunMetrics,
  routed: RunMetrics,
): ScenarioComparison {
  const baselineCost = baseline.cost.estimatedCostUSD;
  const routedCost = routed.cost.estimatedCostUSD;
  const savings = baselineCost - routedCost;
  const savingsPercent = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

  const baselineQuality = baseline.quality.score;
  const routedQuality = routed.quality.score;
  const qualityRetention = baselineQuality > 0 ? (routedQuality / baselineQuality) * 100 : 100;

  return {
    scenarioId,
    scenarioName,
    baseline,
    routed,
    costSavingsPercent: Math.round(savingsPercent * 10) / 10,
    qualityRetentionPercent: Math.round(qualityRetention * 10) / 10,
    baselineCostUSD: baselineCost,
    routedCostUSD: routedCost,
    savingsUSD: savings,
    firstPassRateDeltaPercent:
      Math.round((routed.outcome.firstPassRate - baseline.outcome.firstPassRate) * 100 * 10) / 10,
  };
}
