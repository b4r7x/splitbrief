import {
  reviewFindingCounts,
  reviewOutcomeOf,
  reviewOutcomeWord,
} from '../../../core/review/verdict.js';
import { readSpecFileOrEmpty } from '../../../core/sessions/spec-files.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { parseFinalReview } from '../../parsers/final-review.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { RunnerKind } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readFinalReviewRecord } from '../../../core/review/store.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { sameCurrentBrief } from '../../../core/evidence/same-brief.js';
import {
  briefInFlight,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../../core/state/selectors.js';
import { loadSessionArtifactRollups } from './artifact-rollups.js';
import { resolveCallIdentities } from './call-evidence.js';
import { recordedRunnerKind, type CallIdentity } from './call-identities.js';
import { countLocalAndEscalatedTasks, type BuildSummaryState } from './task-metrics.js';

export type SummaryBase = {
  feature: string;
  startTime: number;
  plannerTool: string;
  plannerModel?: string;
  plannerKind?: RunnerKind;
  plannerAxes?: readonly string[];
  implementerTool: string;
  implementerModel?: string;
  implementerKind?: RunnerKind;
  implementerAxes?: readonly string[];
  reviewerTool?: string;
  reviewerModel?: string;
  reviewerKind?: RunnerKind;
  reviewerAxes?: readonly string[];
  reviewerSeat?: 'none';
  projectDir?: string;
  sessionId?: string;
};

type BuildSummaryOptions = SummaryBase & {
  state: BuildSummaryState & Pick<WorkflowState, 'phase' | 'currentTaskIndex'>;
};

function readReviewOutcome(projectDir: string, sessionId: string): Summary['review'] {
  const ref = { projectDir, sessionId };
  const review = readFinalReviewRecord(ref);
  if (review.kind === 'task-only') return undefined;
  if (review.kind === 'final') {
    const outcome = reviewOutcomeOf(review.record);
    const counts = reviewFindingCounts(outcome);
    return {
      verdict: reviewOutcomeWord(outcome),
      critical: counts.critical,
      warnings: counts.warning,
      notes: counts.note,
    };
  }
  // A session saved before the typed review has only its Markdown.
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
  const current = briefInFlight(state);
  if (current === undefined) return { changedFiles };
  const booked = ledger.tasks.find(
    (task) => task.id === current.id && sameCurrentBrief(task, current),
  );
  return {
    changedFiles,
    stoppedAt: { taskId: current.id, partialFiles: booked?.changedFiles ?? [] },
  };
}

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const {
    feature,
    state,
    startTime,
    plannerTool,
    plannerModel,
    plannerKind: savedPlannerKind,
    plannerAxes,
    implementerTool,
    implementerModel,
    implementerKind: savedImplementerKind,
    implementerAxes,
    reviewerTool,
    reviewerModel,
    reviewerKind: savedReviewerKind,
    reviewerAxes,
    reviewerSeat,
    projectDir,
    sessionId,
  } = opts;
  const kindsMissing =
    savedPlannerKind === undefined ||
    savedImplementerKind === undefined ||
    (reviewerTool !== undefined && savedReviewerKind === undefined);
  const calls =
    kindsMissing && projectDir && sessionId
      ? resolveCallIdentities({ projectDir, sessionId })
      : undefined;
  const inferredKind = (role: CallIdentity['role'], tool: string): RunnerKind | undefined => {
    const kind = recordedRunnerKind(calls, role, tool);
    return kind === 'ambiguous' ? undefined : kind;
  };
  const plannerKind = savedPlannerKind ?? inferredKind('planner', plannerTool);
  const implementerKind = savedImplementerKind ?? inferredKind('implementer', implementerTool);
  const reviewerKind =
    savedReviewerKind ??
    (reviewerTool === undefined ? undefined : inferredKind('review', reviewerTool));
  const { taskBreakdowns } = state;
  const totalTasks = state.tasks.length;
  const completionCounts = countLocalAndEscalatedTasks(state, taskBreakdowns);
  const completedByLocal = completionCounts.local;
  const escalatedToPlanner = completionCounts.escalated;
  const skipped = getSkippedTaskIds(state).length;
  const failed = getFailedTaskIds(state).length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;
  let evidenceSummary: Summary['evidenceSummary'];
  let briefQuality: Summary['briefQuality'];
  let driftSummary: Summary['driftSummary'];
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
    escalationRate,
    taskBreakdown: taskBreakdowns,
    plannerTool,
    plannerModel,
    ...(plannerKind !== undefined && { plannerKind }),
    ...(plannerAxes !== undefined && { plannerAxes }),
    implementerTool,
    implementerModel,
    ...(implementerKind !== undefined && { implementerKind }),
    ...(implementerAxes !== undefined && { implementerAxes }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    ...(reviewerKind !== undefined && { reviewerKind }),
    ...(reviewerAxes !== undefined && { reviewerAxes }),
    ...(reviewerSeat !== undefined && { reviewerSeat }),
    ...(evidenceSummary && { evidenceSummary }),
    ...(briefQuality && { briefQuality }),
    ...(driftSummary && { driftSummary }),
    ...(checkpointSummary && { checkpointSummary }),
    ...(reviewPacket && { reviewPacket }),
    ...(review && { review }),
    ...(changedFiles && { changedFiles }),
    ...(stoppedAt && { stoppedAt }),
  };
}
