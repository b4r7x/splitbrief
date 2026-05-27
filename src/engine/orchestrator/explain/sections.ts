import { REVIEW_FILE, REVIEW_PACKET_JSON_FILE } from '../../../core/paths.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { ReviewPacket } from '../../../core/schemas/review-packet.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';
import { formatCost } from '../../../core/formatting.js';
import { narrowRecord, optionalString } from '../../../utils/type-guards.js';
import { uniqueSorted } from '../../../utils/collections.js';
import { retryCountsFromEvents } from '../evidence/retry-counts.js';
import { artifactPath } from './artifacts.js';
import type {
  DeterministicEstimate,
  ReadinessSummary,
  RunExplain,
  RunExplainArtifact,
  RunExplainRoute,
} from './types.js';

export function sessionStatus(summary: Summary | null, state: WorkflowState | null): string | null {
  if (state?.phase) return state.phase === 'complete' ? 'complete' : 'in-progress';
  return summary ? 'complete' : null;
}

export function buildCost(summary: Summary | null, packet: ReviewPacket | null, routes: RunExplainRoute[]): RunExplain['cost'] {
  const costBreakdown = summary?.costBreakdown ?? packet?.cost.costBreakdown ?? null;
  const deterministic = summary?.costPrediction?.deterministic;
  const unknownPricing = uniqueSorted([
    ...unknownCostReasons(deterministic),
    ...unknownCostFlags(costBreakdown),
    ...routes.flatMap((route) => route.priceConfidence && route.priceConfidence !== 'price-known'
      ? [`${route.taskId}: ${route.priceConfidence}`]
      : []),
  ], { trim: true, nonEmpty: true });
  const confidence = costBreakdown || deterministic
    ? unknownPricing.length > 0 ? 'partial' : 'known'
    : 'unavailable';

  return {
    actual: actualCostLabel(costBreakdown),
    baseline: baselineCostLabel(costBreakdown, deterministic),
    savings: savingsLabel(summary, packet, costBreakdown, deterministic),
    confidence,
    unknownPricing,
    estimate: {
      present: deterministic !== undefined,
      taskFitCounts: deterministic?.taskFitCounts ?? null,
      contextConfidenceCounts: deterministic?.contextConfidenceCounts ?? null,
      priceConfidenceCounts: deterministic?.priceConfidenceCounts ?? null,
      plannerEstimateReview: summary?.costPrediction?.plannerEstimateReview ?? null,
    },
  };
}

export function buildActivity(
  packet: ReviewPacket | null,
  state: WorkflowState | null,
  events: SessionLogEventEntry[],
): RunExplain['activity'] {
  if (packet) return activityFromPacket(packet);
  return {
    retries: retryActivity(events),
    escalatedTasks: taskStatusActivity(state, events, ['escalated'], ['task_escalating', 'escalate']),
    skippedTasks: skippedActivity(state, events),
    failedTasks: taskStatusActivity(state, events, ['failed'], ['task_full_fail']),
    recoveryRisks: state?.pendingRecovery ? [state.pendingRecovery.message] : [],
  };
}

export function buildReview(
  sessionId: string,
  packet: ReviewPacket | null,
  state: WorkflowState | null,
  events: SessionLogEventEntry[],
  artifacts: RunExplainArtifact[],
): RunExplain['review'] {
  const taskReviewEvents = events.filter((event) => event.type === 'task_review_needed');
  const taskReviewIds = uniqueSorted(taskReviewEvents.flatMap((event) => event.taskId ? [event.taskId] : []), { trim: true, nonEmpty: true });
  const reviewPresent = artifacts.find((artifact) => artifact.key === 'review')?.present === true;
  const finalReviewStatus = packet?.finalReview.status
    ?? (reviewPresent ? 'written' : state?.phase === 'complete' ? 'unavailable' : 'not-reached');

  return {
    taskReview: {
      triggeredCount: taskReviewEvents.length,
      taskIds: taskReviewIds,
      status: taskReviewEvents.length > 0 ? 'triggered' : 'not-triggered-or-disabled',
    },
    finalReview: {
      status: finalReviewStatus,
      path: artifactPath(sessionId, REVIEW_FILE),
      evidenceStatus: packet?.finalReview.evidenceStatus ?? null,
    },
    reviewPacket: {
      present: packet !== null,
      path: artifactPath(sessionId, REVIEW_PACKET_JSON_FILE),
      finalReviewStatus: packet?.finalReview.status ?? null,
    },
  };
}

export function buildWarnings(
  readiness: ReadinessSummary | ReviewPacket['readiness'] | null | undefined,
  packet: ReviewPacket | null,
  events: SessionLogEventEntry[],
): RunExplain['warnings'] {
  const readinessWarnings = readiness?.checks
    .filter((check) => check.severity === 'warning')
    .map((check) => `${check.id}: ${check.summary}`) ?? [];
  const runtimeWarnings = packet
    ? packet.escalations.warnings.flatMap((event) => event.message ? [`${event.type}: ${event.message}`] : [event.type])
    : events
      .filter((event) => event.type === 'warning' || event.type === 'budget_warning' || event.type === 'budget_paused' || event.type === 'budget_exceeded')
      .map((event) => `${event.type}: ${eventMessage(event) ?? 'see session log'}`);

  return {
    readinessStatus: readiness?.status ?? null,
    silentReadinessWarnings: readinessWarnings,
    runtimeWarnings,
    missingArtifacts: packet?.missingArtifacts ?? [],
  };
}

function activityFromPacket(packet: ReviewPacket): RunExplain['activity'] {
  const routeMethod = new Map(packet.cost.taskRouting.map((route) => [route.taskId, route.method]));
  return {
    retries: packet.escalations.retries.map((retry) => ({ ...retry })),
    escalatedTasks: packet.escalations.escalatedTasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      method: task.method ?? routeMethod.get(task.taskId) ?? null,
    })),
    skippedTasks: packet.escalations.skippedTasks.map((task) => ({ ...task })),
    failedTasks: packet.escalations.failedTasks.map((task) => ({ ...task })),
    recoveryRisks: packet.recoveryDecisions.unresolvedRisks,
  };
}

function actualCostLabel(costBreakdown: Summary['costBreakdown'] | ReviewPacket['cost']['costBreakdown'] | null): string {
  if (!costBreakdown) return 'unavailable';
  const cost = formatCost(costBreakdown.totalActualCost);
  return costBreakdown.isTotalActualCostKnown === false ? `${cost} + unknown` : cost;
}

function baselineCostLabel(
  costBreakdown: Summary['costBreakdown'] | ReviewPacket['cost']['costBreakdown'] | null,
  deterministic: DeterministicEstimate | undefined,
): string {
  if (costBreakdown) {
    const cost = formatCost(costBreakdown.hypotheticalCost);
    return costBreakdown.isAllPlannerBaselineKnown === false ? `${cost} + unknown` : cost;
  }
  return deterministic?.totals.hypotheticalAllPlanner === null || deterministic === undefined
    ? 'unavailable'
    : formatCost(deterministic.totals.hypotheticalAllPlanner);
}

function savingsLabel(
  summary: Summary | null,
  packet: ReviewPacket | null,
  costBreakdown: Summary['costBreakdown'] | ReviewPacket['cost']['costBreakdown'] | null,
  deterministic: DeterministicEstimate | undefined,
): string {
  if (costBreakdown?.hasSavingsEstimate === false) return 'unavailable';
  if (summary?.estimatedCostSavings) return summary.estimatedCostSavings;
  if (packet?.cost.estimatedCostSavings) return packet.cost.estimatedCostSavings;
  if (costBreakdown) return formatCost(costBreakdown.savingsAmount);
  return deterministic?.totals.estimatedSavings === null || deterministic === undefined
    ? 'unavailable'
    : formatCost(deterministic.totals.estimatedSavings);
}

function unknownCostReasons(deterministic: DeterministicEstimate | undefined): string[] {
  return deterministic?.totals.unknownCostReason.map((reason) => {
    switch (reason) {
      case 'implementer-price-unknown': return 'implementer price unknown';
      case 'planner-price-unknown':     return 'planner baseline price unknown';
      case 'profile-unavailable':       return 'profile unavailable';
      default:                          return reason;
    }
  }) ?? [];
}

function unknownCostFlags(costBreakdown: Summary['costBreakdown'] | ReviewPacket['cost']['costBreakdown'] | null): string[] {
  if (!costBreakdown) return [];
  const reasons: string[] = [];
  if (costBreakdown.hasUnpricedUsage) reasons.push('run has unpriced usage');
  if (costBreakdown.isTotalActualCostKnown === false) reasons.push('actual cost is partially unknown');
  if (costBreakdown.isAllPlannerBaselineKnown === false) reasons.push('all-planner baseline is partially unknown');
  if (costBreakdown.hasSavingsEstimate === false) reasons.push('savings estimate unavailable');
  return reasons;
}

function retryActivity(events: SessionLogEventEntry[]): RunExplain['activity']['retries'] {
  const retries = retryCountsFromEvents(events, eventMessage);
  return [...retries.entries()]
    .map(([taskId, retry]) => ({ taskId, ...retry }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function taskStatusActivity(
  state: WorkflowState | null,
  events: SessionLogEventEntry[],
  statuses: string[],
  eventTypes: string[],
): Array<{ taskId: string; title: string | null; method: string | null }> {
  const tasks = new Map<string, { taskId: string; title: string | null; method: string | null }>();
  for (const task of state?.tasks ?? []) {
    if (statuses.includes(task.status)) tasks.set(task.id, { taskId: task.id, title: task.title, method: null });
  }
  for (const event of events) {
    if (!event.taskId || !eventTypes.includes(event.type)) continue;
    const data = narrowRecord(event.data);
    tasks.set(event.taskId, {
      taskId: event.taskId,
      title: optionalString(data?.title, { trim: true, nonEmpty: true }) ?? tasks.get(event.taskId)?.title ?? null,
      method: optionalString(data?.method, { trim: true, nonEmpty: true }) ?? null,
    });
  }
  return [...tasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function skippedActivity(state: WorkflowState | null, events: SessionLogEventEntry[]): RunExplain['activity']['skippedTasks'] {
  const tasks = new Map<string, { taskId: string; title: string | null; reason: string | null }>();
  for (const task of state?.tasks ?? []) {
    if (task.status === 'skipped') tasks.set(task.id, { taskId: task.id, title: task.title, reason: null });
  }
  for (const event of events) {
    if (event.type !== 'task_skipped' || !event.taskId) continue;
    const data = narrowRecord(event.data);
    tasks.set(event.taskId, {
      taskId: event.taskId,
      title: optionalString(data?.title, { trim: true, nonEmpty: true }) ?? tasks.get(event.taskId)?.title ?? null,
      reason: optionalString(data?.reason, { trim: true, nonEmpty: true }) ?? eventMessage(event),
    });
  }
  return [...tasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function eventMessage(event: SessionLogEventEntry): string | null {
  const data = narrowRecord(event.data);
  return optionalString(data?.message, { trim: true, nonEmpty: true })
    ?? optionalString(data?.error, { trim: true, nonEmpty: true })
    ?? optionalString(data?.reason, { trim: true, nonEmpty: true })
    ?? optionalString(data?.routingReason, { trim: true, nonEmpty: true })
    ?? null;
}
