import type { RunExplain, RunExplainRoute } from './explain-types.js';

const MAX_ROUTING_LINES = 20;

export function formatRunExplain(explain: RunExplain): string {
  return [
    'Run explain',
    '',
    `Session: ${explain.sessionId}`,
    `Feature: ${explain.feature}`,
    `Phase: ${explain.phase ?? 'unavailable'}`,
    '',
    'Cost:',
    `- actual: ${explain.cost.actual}`,
    `- baseline: ${explain.cost.baseline}`,
    `- savings: ${explain.cost.savings}`,
    `- confidence: ${costConfidenceLine(explain)}`,
    ...listLines('unknown pricing', explain.cost.unknownPricing),
    '',
    'Routing:',
    ...routingLines(explain.routing),
    '',
    'Retries and escalations:',
    ...activityLines(explain),
    '',
    'Review:',
    `- task review: ${taskReviewLine(explain)}`,
    `- final review: ${explain.review.finalReview.status} (${explain.review.finalReview.path})`,
    `- review packet: ${explain.review.reviewPacket.present ? explain.review.reviewPacket.path : 'missing'}`,
    '',
    'Warnings:',
    `- readiness: ${explain.warnings.readinessStatus ?? 'unavailable'}`,
    ...listLines('readiness warnings', explain.warnings.silentReadinessWarnings),
    ...listLines('runtime warnings', explain.warnings.runtimeWarnings),
    '',
    'Artifacts:',
    ...explain.artifacts.map((artifact) => `- ${artifact.key}: ${artifact.present ? artifact.path : `${artifact.path} (missing)`}`),
    '',
  ].join('\n');
}

function costConfidenceLine(explain: RunExplain): string {
  const estimate = explain.cost.estimate;
  if (!estimate.present) return explain.cost.confidence;
  const fit = estimate.taskFitCounts
    ? `fits ${estimate.taskFitCounts.fits}, tight ${estimate.taskFitCounts.tight}, overflow ${estimate.taskFitCounts.overflow}, unknown ${estimate.taskFitCounts.unknown}`
    : 'fit counts unavailable';
  const price = estimate.priceConfidenceCounts
    ? `price known ${estimate.priceConfidenceCounts.priceKnown}, unknown ${estimate.priceConfidenceCounts.priceUnknown}, profile n/a ${estimate.priceConfidenceCounts.profileUnavailable}`
    : 'price counts unavailable';
  const review = estimate.plannerEstimateReview
    ? `planner review ${estimate.plannerEstimateReview.status}`
    : 'planner review not requested';
  return `${explain.cost.confidence}; ${fit}; ${price}; ${review}`;
}

function routingLines(routes: RunExplainRoute[]): string[] {
  if (routes.length === 0) return ['- No routing artifacts found.'];
  const visible = routes.slice(0, MAX_ROUTING_LINES).map(formatRoute);
  const hidden = routes.length - visible.length;
  return hidden > 0
    ? [...visible, `- ${hidden} more task route(s) omitted; see summary.json or review-packet.json.`]
    : visible;
}

function formatRoute(route: RunExplainRoute): string {
  const target = route.selectedProfile ?? route.tool ?? 'no selected profile';
  const fit = route.contextFit ?? 'fit unavailable';
  const context = route.contextConfidence ?? 'context confidence unavailable';
  const price = route.priceConfidence ?? 'price confidence unavailable';
  const tokenText = route.estimatedTokens === null ? '' : `, ${route.estimatedTokens} est tokens`;
  const notes = route.notes.length > 0 ? `; ${route.notes.join('; ')}` : '';
  return `- ${route.taskId} -> ${target}: ${fit}, ${context}, ${price}${tokenText}${notes}`;
}

function activityLines(explain: RunExplain): string[] {
  const lines = [
    ...explain.activity.retries.map((retry) =>
      `- retry ${retry.taskId}: ${retry.retryCount}${retry.lastError ? ` (${retry.lastError})` : ''}`
    ),
    ...explain.activity.escalatedTasks.map((task) =>
      `- escalated ${task.taskId}${task.method ? ` via ${task.method}` : ''}${task.title ? `: ${task.title}` : ''}`
    ),
    ...explain.activity.skippedTasks.map((task) =>
      `- skipped ${task.taskId}${task.reason ? `: ${task.reason}` : ''}`
    ),
    ...explain.activity.failedTasks.map((task) =>
      `- failed ${task.taskId}${task.title ? `: ${task.title}` : ''}`
    ),
    ...explain.activity.recoveryRisks.map((risk) => `- recovery risk: ${risk}`),
  ];
  return lines.length > 0 ? lines : ['- None recorded.'];
}

function taskReviewLine(explain: RunExplain): string {
  if (explain.review.taskReview.triggeredCount === 0) return explain.review.taskReview.status;
  const ids = explain.review.taskReview.taskIds.length > 0
    ? ` (${explain.review.taskReview.taskIds.join(', ')})`
    : '';
  return `${explain.review.taskReview.triggeredCount} gate(s) triggered${ids}`;
}

function listLines(label: string, items: string[]): string[] {
  return items.length === 0
    ? [`- ${label}: none recorded`]
    : items.map((item) => `- ${label}: ${item}`);
}
