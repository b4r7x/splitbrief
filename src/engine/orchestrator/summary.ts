import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary, CostPrediction } from '../../core/schemas/summary.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { calculateCostBreakdown, getProviderPricing, calculateCost } from '../providers/pricing.js';
import { formatCost } from '../../core/formatting.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../core/state/selectors.js';
import { buildEvidenceSummary, readEvidenceLedger } from './evidence.js';
import { readDriftReport } from './drift.js';
import { readDriftChainState } from './drift-chain-state.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../core/paths.js';
import type { BriefQualityReport } from '../spec/brief-quality.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = { feature: string; startTime: number; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string; mode?: WorkflowMode; projectDir?: string; sessionId?: string };

type BuildSummaryOptions = {
  feature: string;
  state: BuildSummaryState;
  startTime: number;
  taskBreakdowns?: TaskTokenUsage[];
  plannerTool: string;
  plannerModel?: string;
  implementerTool: string;
  implementerModel?: string;
  phaseTimings?: Record<string, number>;
  mode?: WorkflowMode;
  projectDir?: string;
  sessionId?: string;
  costPrediction?: CostPrediction | undefined;
};

function readBriefQualityReport(projectDir: string, sessionId: string): BriefQualityReport | null {
  const target = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as BriefQualityReport;
  } catch {
    return null;
  }
}

export function calculateTaskCost(
  task: TaskTokenUsage,
  globalUsage: { implementerInput: number; implementerOutput: number; escalationInput: number; escalationOutput: number },
  implementerTool: string,
  plannerTool: string,
  implementerModel?: string | undefined,
  plannerModel?: string | undefined,
): number {
  const implementerPricing = getProviderPricing(implementerTool, implementerModel);
  const plannerPricing = getProviderPricing(plannerTool, plannerModel);

  const totalImplementerTokens = globalUsage.implementerInput + globalUsage.implementerOutput;
  const implementerCostPerToken = totalImplementerTokens > 0
    ? calculateCost(globalUsage.implementerInput, globalUsage.implementerOutput, implementerPricing) / totalImplementerTokens
    : 0;

  const totalEscalationTokens = globalUsage.escalationInput + globalUsage.escalationOutput;
  const escalationCostPerToken = totalEscalationTokens > 0
    ? calculateCost(globalUsage.escalationInput, globalUsage.escalationOutput, plannerPricing) / totalEscalationTokens
    : 0;

  return task.implementerTokens * implementerCostPerToken + task.escalationTokens * escalationCostPerToken;
}

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const { feature, state, startTime, taskBreakdowns, plannerTool, plannerModel, implementerTool, implementerModel, phaseTimings, mode, projectDir, sessionId, costPrediction } = opts;
  const totalTasks = state.tasks.length;
  const completedByLocal = getCompletedTaskIds(state).length;
  const escalatedToPlanner = getEscalatedTaskIds(state).length;
  const skipped = getSkippedTaskIds(state).length;
  const failed = getFailedTaskIds(state).length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;

  const costBreakdown = calculateCostBreakdown({
    tokenUsage: state.tokenUsage,
    totalTasks,
    escalatedCount: escalatedToPlanner,
    plannerTool,
    implementerTool,
    plannerModel,
    implementerModel,
  });
  const estimatedCostSavings = formatCost(costBreakdown.savingsAmount);

  const costedBreakdowns = taskBreakdowns?.map(task => ({
    ...task,
    cost: calculateTaskCost(task, state.tokenUsage, implementerTool, plannerTool, implementerModel, plannerModel),
  }));

  let evidenceSummary: Summary['evidenceSummary'];
  let briefQuality: Summary['briefQuality'];
  let driftSummary: Summary['driftSummary'];
  let chainDriftSummary: Summary['chainDriftSummary'];
  if (projectDir && sessionId) {
    const ledger = readEvidenceLedger(projectDir, sessionId);
    if (ledger) evidenceSummary = buildEvidenceSummary(ledger);

    const bqReport = readBriefQualityReport(projectDir, sessionId);
    if (bqReport) {
      briefQuality = {
        score: bqReport.score,
        passed: bqReport.passed,
        errorCount: bqReport.issues.filter(i => i.severity === 'error').length,
        warningCount: bqReport.issues.filter(i => i.severity === 'warning').length,
      };
    }

    const drift = readDriftReport(projectDir, sessionId);
    if (drift) {
      driftSummary = {
        passed: drift.passed,
        score: drift.score,
        errorCount: drift.findings.filter(f => f.severity === 'error').length,
        warningCount: drift.findings.filter(f => f.severity === 'warning').length,
      };
    }

    const chainState = readDriftChainState(projectDir, sessionId);
    if (chainState && chainState.emittedChains.length > 0) {
      const best = chainState.emittedChains.reduce((a, b) => a.score >= b.score ? a : b);
      chainDriftSummary = {
        score: best.score,
        chainLength: best.chainLength,
        uniqueOutOfBoundsFiles: best.uniqueOutOfBoundsFiles,
        representativePath: best.representativePath,
        emittedChainCount: chainState.emittedChains.length,
      };
    }
  }

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown: costedBreakdowns,
    costBreakdown,
    plannerTool,
    plannerModel,
    implementerTool,
    implementerModel,
    phaseTimings,
    ...(mode !== undefined && { mode }),
    ...(evidenceSummary && { evidenceSummary }),
    ...(briefQuality && { briefQuality }),
    ...(driftSummary && { driftSummary }),
    ...(chainDriftSummary && { chainDriftSummary }),
    ...(costPrediction !== undefined && { costPrediction }),
  };
}
