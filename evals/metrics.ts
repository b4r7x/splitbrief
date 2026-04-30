import type { CostBreakdown, Summary } from '../src/core/schemas/summary.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import type { QualityCheckResult } from './scenarios/types.js';

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
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
  costBreakdown: CostBreakdown | null;
};

export type RunMetrics = {
  scenarioId: string;
  mode: 'baseline' | 'routed';
  durationMs: number;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  escalatedTasks: number;
  skippedTasks: number;
  retryCount: number;
  quality: QualityScore;
  cost: CostMetrics;
  testsPassedAfterRun: boolean;
  events: EngineEvent[];
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
};

export type EvalReport = {
  timestamp: string;
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  scenarios: ScenarioComparison[];
  aggregate: {
    avgCostSavingsPercent: number;
    avgQualityRetentionPercent: number;
    totalBaselineCostUSD: number;
    totalRoutedCostUSD: number;
    totalSavingsUSD: number;
    scenariosRun: number;
    scenariosWhereRoutedMatchedBaseline: number;
  };
};

export function collectCostMetrics(summary: Summary): CostMetrics {
  const usage = summary.tokenUsage;
  return {
    plannerInputTokens: usage.plannerInput,
    plannerOutputTokens: usage.plannerOutput,
    implementerInputTokens: usage.implementerInput,
    implementerOutputTokens: usage.implementerOutput,
    escalationInputTokens: usage.escalationInput,
    escalationOutputTokens: usage.escalationOutput,
    totalInputTokens: usage.plannerInput + usage.implementerInput + usage.escalationInput,
    totalOutputTokens: usage.plannerOutput + usage.implementerOutput + usage.escalationOutput,
    estimatedCostUSD: summary.costBreakdown?.totalActualCost ?? 0,
    costBreakdown: summary.costBreakdown ?? null,
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

export function collectRunMetrics(
  scenarioId: string,
  mode: 'baseline' | 'routed',
  summary: Summary,
  events: EngineEvent[],
  qualityResults: QualityCheckResult[],
  durationMs: number,
): RunMetrics {
  const retryEvents = events.filter((event) => event.type === 'task_retry');
  return {
    scenarioId,
    mode,
    durationMs,
    taskCount: summary.totalTasks,
    completedTasks: summary.completedByLocal + summary.escalatedToPlanner,
    failedTasks: summary.failed,
    escalatedTasks: summary.escalatedToPlanner,
    skippedTasks: summary.skipped,
    retryCount: retryEvents.length,
    quality: collectQualityScore(qualityResults),
    cost: collectCostMetrics(summary),
    testsPassedAfterRun: qualityResults.every((result) => result.passed),
    events,
  };
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
  };
}
