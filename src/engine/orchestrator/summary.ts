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
} from '../providers/cost.js';
import type { ModelCacheAccessor } from '../providers/model/resolution.js';
import { formatCost } from '../../core/formatting.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../core/state/selectors.js';
import { classifyTaskCompletionMethod } from '../../core/task-completion.js';
import { readEvidenceLedger } from '../../core/evidence/ledger.js';
import { buildEvidenceSummary } from './evidence/reporting.js';
import { readDriftReport } from './drift/io.js';
import { readDriftChainState } from './drift/chain-state.js';
import {
  BRIEF_QUALITY_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  reviewPacketJsonPath,
  sessionDir,
} from '../../core/paths.js';
import { isBriefQualityReport, type BriefQualityReport } from '../spec/brief-quality.js';
import { readJsonSafe } from '../../lib/fs.js';
import { countBySeverity } from '../../utils/collections.js';
import { projectCostPredictionForTranscriptPolicy } from '../events/protection.js';
import { featureForTranscriptPolicy } from '../../core/sessions/lifecycle.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = {
  feature: string;
  startTime: number;
  plannerTool: string;
  plannerModel?: string;
  implementerTool: string;
  implementerModel?: string;
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

function countLocalAndEscalatedTasks(
  state: BuildSummaryState,
  taskBreakdowns: TaskTokenUsage[] | undefined,
): { local: number; escalated: number } {
  const latestMethodByTask = new Map<string, TaskTokenUsage['method']>();
  for (const breakdown of taskBreakdowns ?? []) {
    latestMethodByTask.set(breakdown.taskId, breakdown.method);
  }

  let local = 0;
  let escalated = 0;
  for (const task of state.tasks) {
    if (task.status !== 'done' && task.status !== 'escalated') continue;
    const method = latestMethodByTask.get(task.id);
    if (method) {
      const completionClass = classifyTaskCompletionMethod(method);
      if (completionClass === 'local') local += 1;
      else if (completionClass === 'escalated') escalated += 1;
      continue;
    }
    if (task.status === 'done') local += 1;
    else escalated += 1;
  }
  return { local, escalated };
}

function projectTaskBreakdownForTranscriptPolicy(task: TaskTokenUsage): TaskTokenUsage {
  const { routingReason, costPosture, ...base } = task;
  return {
    ...base,
    taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
    ...(routingReason !== undefined && { routingReason: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(costPosture !== undefined && { costPosture: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

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

  const costBreakdown = calculateCostBreakdown(
    {
      tokenUsage: state.tokenUsage,
      totalTasks,
      escalatedCount: escalatedToPlanner,
      completedLocalTasks: completedByLocal,
      plannerTool,
      implementerTool,
      plannerModel,
      implementerModel,
      taskBreakdowns,
    },
    pricingCache,
  );
  const estimatedCostSavings = costBreakdown.hasSavingsEstimate
    ? formatCost(costBreakdown.savingsAmount)
    : 'unavailable';

  const costedBreakdowns = taskBreakdowns?.map((task) => {
    const isCostKnown = isTaskUsageCostKnown({
      task,
      tokenUsage: state.tokenUsage,
      implementerTool,
      plannerTool,
      implementerModel,
      plannerModel,
      cache: pricingCache,
    });
    const { cost: _cost, ...rest } = task;
    return {
      ...rest,
      ...(isCostKnown
        ? {
            cost: calculateTaskUsageCost({
              task: task,
              tokenUsage: state.tokenUsage,
              implementerTool: implementerTool,
              plannerTool: plannerTool,
              implementerModel: implementerModel,
              plannerModel: plannerModel,
              cache: pricingCache,
            }),
          }
        : { costPosture: task.costPosture ?? 'unknown-price' }),
    };
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
    const ledger = readEvidenceLedger(projectDir, sessionId);
    if (ledger) evidenceSummary = buildEvidenceSummary(ledger);

    const bqReport = readBriefQualityReport(projectDir, sessionId);
    if (bqReport) {
      const counts = countBySeverity(bqReport.issues);
      briefQuality = {
        score: bqReport.score,
        passed: bqReport.passed,
        errorCount: counts.error,
        warningCount: counts.warning,
      };
    }

    const drift = readDriftReport(projectDir, sessionId);
    if (drift) {
      const counts = countBySeverity(drift.findings);
      driftSummary = {
        passed: drift.passed,
        score: drift.score,
        errorCount: counts.error,
        warningCount: counts.warning,
      };
    }

    const chainState = readDriftChainState(projectDir, sessionId);
    if (chainState && chainState.emittedChains.length > 0) {
      const best = chainState.emittedChains.reduce((a, b) => (a.score >= b.score ? a : b));
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
    feature: featureForTranscriptPolicy(feature, persistTranscript),
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown,
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
    ...(costPrediction !== undefined && {
      costPrediction: projectCostPredictionForTranscriptPolicy(costPrediction, persistTranscript),
    }),
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
  };
}
