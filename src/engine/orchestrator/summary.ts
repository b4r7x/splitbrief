import { join } from 'node:path';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary, CostPrediction } from '../../core/schemas/summary.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { ReviewPacketCheckpoint } from '../../core/schemas/review-packet.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import {
  calculateCostBreakdown,
  calculateTaskUsageCost,
  isTaskUsageCostKnown,
  type TaskCostTokenUsage,
} from '../providers/pricing.js';
import { formatCost } from '../../core/formatting.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../core/state/selectors.js';
import { readEvidenceLedger } from './evidence/persistence.js';
import { buildEvidenceSummary } from './evidence/reporting.js';
import { readDriftReport } from './drift/drift.js';
import { readDriftChainState } from './drift/chain-state.js';
import { BRIEF_QUALITY_FILE, REVIEW_PACKET_JSON_FILE, REVIEW_PACKET_MARKDOWN_FILE, reviewPacketJsonPath, sessionDir } from '../../core/paths.js';
import { isBriefQualityReport, type BriefQualityReport } from '../spec/brief-quality.js';
import { readJsonSafe } from '../../lib/fs.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = { feature: string; startTime: number; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string; mode?: WorkflowMode; projectDir?: string; sessionId?: string; costPrediction?: CostPrediction | undefined };

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
  const raw = readJsonSafe(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE));
  if (raw === null) return null;
  return isBriefQualityReport(raw) ? raw : null;
}

function readReviewPacketRollups(
  projectDir: string,
  sessionId: string,
): { checkpointSummary?: Summary['checkpointSummary']; reviewPacket?: Summary['reviewPacket'] } {
  const raw = readJsonSafe(reviewPacketJsonPath(projectDir, sessionId));
  if (raw === null) return {};
  const parsed = ReviewPacketSchema.safeParse(raw);
  if (!parsed.success) return {};
  const packet = parsed.data;
  const latest = packet.checkpoints.latestRunCheckpoint ?? packet.checkpoints.items.at(-1) ?? null;
  return {
    checkpointSummary: {
      count: packet.checkpoints.items.length,
      latestId: latest?.id ?? null,
      latestName: latest?.name ?? null,
      latestKind: checkpointKindLabel(latest),
      latestRunCheckpointId: packet.checkpoints.latestRunCheckpoint?.id ?? null,
      preFinalReviewId: packet.checkpoints.preFinalReview?.id ?? null,
      accepted: packet.checkpoints.runLedger.accepted,
      rejected: packet.checkpoints.runLedger.rejected,
      diffCommand: latest?.diffCommand ?? null,
      restoreCommand: latest?.restoreCommand ?? null,
    },
    reviewPacket: {
      jsonPath: REVIEW_PACKET_JSON_FILE,
      markdownPath: REVIEW_PACKET_MARKDOWN_FILE,
      generatedAt: packet.generatedAt,
      finalReviewStatus: packet.finalReview.status,
      driftPassed: packet.drift.passed,
      evidenceValidatedTasks: packet.validation.summary.passed,
      evidenceTotalTasks: packet.run.totalTasks,
      missingArtifactCount: packet.missingArtifacts.length,
    },
  };
}

function checkpointKindLabel(checkpoint: ReviewPacketCheckpoint | null): string | null {
  if (!checkpoint) return null;
  return checkpoint.inferredKind
    ? `${checkpoint.kind} (inferred ${checkpoint.inferredKind})`
    : checkpoint.kind;
}

export function calculateTaskCost(
  task: TaskTokenUsage,
  globalUsage: TaskCostTokenUsage,
  implementerTool: string,
  plannerTool: string,
  implementerModel?: string | undefined,
  plannerModel?: string | undefined,
): number {
  return calculateTaskUsageCost(
    task,
    globalUsage,
    implementerTool,
    plannerTool,
    implementerModel,
    plannerModel,
  );
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
    taskBreakdowns,
  });
  const estimatedCostSavings = costBreakdown.hasSavingsEstimate
    ? formatCost(costBreakdown.savingsAmount)
    : 'unavailable';

  const costedBreakdowns = taskBreakdowns?.map(task => {
    const isCostKnown = isTaskUsageCostKnown(task, implementerTool, plannerTool, implementerModel, plannerModel);
    const taskWithoutCost = { ...task };
    delete taskWithoutCost.cost;
    return {
      ...taskWithoutCost,
      ...(isCostKnown
        ? { cost: calculateTaskCost(task, state.tokenUsage, implementerTool, plannerTool, implementerModel, plannerModel) }
        : { costPosture: task.costPosture ?? 'unknown-price' }),
    };
  });

  let evidenceSummary: Summary['evidenceSummary'];
  let briefQuality: Summary['briefQuality'];
  let driftSummary: Summary['driftSummary'];
  let chainDriftSummary: Summary['chainDriftSummary'];
  let checkpointSummary: Summary['checkpointSummary'];
  let reviewPacket: Summary['reviewPacket'];
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

    const packetRollups = readReviewPacketRollups(projectDir, sessionId);
    checkpointSummary = packetRollups.checkpointSummary;
    reviewPacket = packetRollups.reviewPacket;
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
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
  };
}
