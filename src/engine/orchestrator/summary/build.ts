import {
  reviewFindingCounts,
  reviewOutcomeOf,
  reviewOutcomeWord,
} from '../../../core/review/verdict.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { readReviewRecord } from '../../../core/review/store.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { parseFinalReview } from '../../parsers/final-review.js';
import { calculateCostBreakdown } from '../../providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../../core/state/selectors.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';
import { resolveCallUsageEvidence } from './call-evidence.js';
import { reconcileTokenUsageWithSessionLog } from './usage-reconcile.js';
import {
  applyTaskBreakdownCosts,
  countLocalAndEscalatedTasks,
  type BuildSummaryState,
} from './task-metrics.js';

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
  plannerKind?: RunnerKind;
  implementerTool: string;
  implementerModel?: string;
  implementerKind?: RunnerKind;
  reviewerTool?: string;
  reviewerModel?: string;
  reviewerKind?: RunnerKind;
  projectDir?: string;
  sessionId?: string;
  pricingCache?: ModelCacheAccessor | undefined;
};

type BuildSummaryOptions = SummaryBase & {
  state: BuildSummaryState & Pick<WorkflowState, 'phase' | 'currentTaskIndex'>;
  taskBreakdowns?: TaskTokenUsage[];
  phaseTimings?: Record<string, number>;
  /**
   * The run's per-call usage records (`collectCallUsageEvidence`). A caller that
   * holds the event stream can supply them; otherwise the run's own session
   * supplies them, live or off its log.
   */
  callEvidence?: readonly CallUsageEvidence[];
};

function readReviewOutcome(projectDir: string, sessionId: string): Summary['review'] {
  const ref = { projectDir, sessionId };
  const record = readReviewRecord(ref);
  if (record !== null) {
    const outcome = reviewOutcomeOf(record);
    const counts = reviewFindingCounts(outcome);
    return {
      verdict: reviewOutcomeWord(outcome),
      critical: counts.critical,
      warnings: counts.warning,
      notes: counts.note,
    };
  }
  const markdown = readSpecFileOrEmpty(ref, REVIEW_FILE);
  if (markdown === '') return undefined;
  const { verdict, findings } = parseFinalReview(markdown);
  return {
    verdict,
    critical: findings.filter((f) => f.severity === 'critical').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    notes: findings.filter((f) => f.severity === 'note').length,
  };
}

/**
 * The run's attributed changed set is what the evidence ledger booked against
 * its briefs — the files the run is answerable for, not every dirty path in the
 * tree. A run that stopped mid-brief reports that brief's share as partial.
 */
function readFileAttribution(
  projectDir: string,
  sessionId: string,
  state: BuildSummaryOptions['state'],
): { changedFiles?: string[]; stoppedAt?: Summary['stoppedAt'] } {
  const ledger = readEvidenceLedger({ projectDir, sessionId });
  if (ledger === null) return {};
  const changedFiles = [...new Set(ledger.tasks.flatMap((task) => task.changedFiles))].sort();
  const current = state.phase === 'complete' ? undefined : state.tasks[state.currentTaskIndex];
  if (current?.status !== 'in_progress') return { changedFiles };
  const booked = ledger.tasks.find((task) => task.id === current.id);
  const currentPlanHash = hashTaskBrief(state.tasks);
  const sameBrief =
    booked !== undefined &&
    booked.status === 'in_progress' &&
    (booked.briefHash != null
      ? booked.briefHash === currentPlanHash
      : booked.title === current.title && booked.file === current.file);
  return {
    changedFiles,
    stoppedAt: { taskId: current.id, partialFiles: sameBrief && booked ? booked.changedFiles : [] },
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
    plannerKind,
    implementerTool,
    implementerModel,
    implementerKind,
    reviewerTool,
    reviewerModel,
    reviewerKind,
    phaseTimings,
    projectDir,
    sessionId,
    pricingCache,
    callEvidence,
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

  // Per-call evidence is the run's own, so the run supplies it: from the live
  // recorder while this process owns the bus, and from the session log for a run
  // read back off disk. A caller holding the stream itself may pass its own.
  const callUsage =
    callEvidence ??
    (projectDir && sessionId ? resolveCallUsageEvidence({ projectDir, sessionId }) : undefined);

  const costBreakdown = calculateCostBreakdown(
    {
      tokenUsage,
      plannerTool: plannerSpentTool,
      implementerTool: implementerSpentTool,
      plannerModel: plannerSpentModel,
      implementerModel: implementerSpentModel,
      ...(reviewerSpentTool !== undefined && { reviewerTool: reviewerSpentTool }),
      ...(reviewerSpentModel !== undefined && { reviewerModel: reviewerSpentModel }),
      taskBreakdowns,
      ...(callUsage !== undefined && { callEvidence: callUsage }),
    },
    pricingCache,
  );
  const costedBreakdowns = applyTaskBreakdownCosts({
    taskBreakdowns,
    plannerTool: plannerSpentTool,
    implementerTool: implementerSpentTool,
    ...(plannerSpentModel !== undefined && { plannerModel: plannerSpentModel }),
    ...(implementerSpentModel !== undefined && { implementerModel: implementerSpentModel }),
    pricingCache,
    ...(callUsage !== undefined && { callEvidence: callUsage }),
  });

  let evidenceSummary: Summary['evidenceSummary'];
  let briefQuality: Summary['briefQuality'];
  let driftSummary: Summary['driftSummary'];
  let chainDriftSummary: Summary['chainDriftSummary'];
  let checkpointSummary: Summary['checkpointSummary'];
  let reviewPacket: Summary['reviewPacket'];
  let review: Summary['review'];
  let changedFiles: string[] | undefined;
  let stoppedAt: Summary['stoppedAt'];
  if (projectDir && sessionId) {
    const rollups = loadSessionArtifactRollups(projectDir, sessionId);
    evidenceSummary = rollups.evidenceSummary;
    briefQuality = rollups.briefQuality;
    driftSummary = rollups.driftSummary;
    chainDriftSummary = rollups.chainDriftSummary;
    checkpointSummary = rollups.checkpointSummary;
    reviewPacket = rollups.reviewPacket;
    review = readReviewOutcome(projectDir, sessionId);
    ({ changedFiles, stoppedAt } = readFileAttribution(projectDir, sessionId, state));
  }

  return {
    feature,
    phase: state.phase,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage,
    escalationRate,
    taskBreakdown: costedBreakdowns,
    costBreakdown,
    plannerTool,
    plannerModel,
    ...(plannerKind !== undefined && { plannerKind }),
    implementerTool,
    implementerModel,
    ...(implementerKind !== undefined && { implementerKind }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    ...(reviewerKind !== undefined && { reviewerKind }),
    phaseTimings,
    ...(evidenceSummary && { evidenceSummary }),
    ...(briefQuality && { briefQuality }),
    ...(driftSummary && { driftSummary }),
    ...(chainDriftSummary && { chainDriftSummary }),
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
    ...(review && { review }),
    ...(changedFiles && { changedFiles }),
    ...(stoppedAt && { stoppedAt }),
  };
}
