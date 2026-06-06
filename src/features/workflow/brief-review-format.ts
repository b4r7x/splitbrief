import type { Task } from '../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../engine/spec/brief-quality.js';
import { uniqueSorted } from '../../utils/collections.js';
import { pluralize } from '../../utils/pluralize.js';
import { STALE_ESTIMATE_STATUSES, hasStaleOrConflict } from '../../core/plan-review/predicates.js';
import type { PlanReviewRisk, PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import type { ImplementerCostTier } from '../../core/schemas/implementer-config.js';

const COST_TIER_ORDER: ImplementerCostTier[] = [
  'local',
  'cheap',
  'standard',
  'frontier',
  'unknown',
];

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function hasTaskReviewWarning(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): boolean {
  return (
    issues.some((i) => i.severity === 'error' || i.severity === 'warning') ||
    hasBlockingReviewState(metadata)
  );
}

function hasBlockingReviewState(metadata?: PlanTaskReviewMetadata | undefined): boolean {
  return (
    metadata?.contextFit === 'overflow' ||
    (metadata !== undefined && metadata.workerProfile === undefined) ||
    metadata?.validationStatus === 'fail' ||
    metadata?.validationStatus === 'warn' ||
    hasStaleOrConflict(metadata)
  );
}

export function getTaskStatusSymbol(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): '⚠' | '✓' {
  return issues.some((i) => i.severity === 'error') || hasBlockingReviewState(metadata) ? '⚠' : '✓';
}

export function buildTaskDetailParts(task: Task): string {
  const validationCount = task.tests.length;
  const evidenceCount = task.evidence?.length ?? 0;
  const hasScope =
    (task.scope?.inBounds?.length ?? 0) > 0 || (task.scope?.outOfBounds?.length ?? 0) > 0;
  const parts: string[] = [];
  if (validationCount > 0)
    parts.push(`validation: ${validationCount} ${pluralize(validationCount, 'check')}`);
  if (evidenceCount > 0) parts.push(`evidence: ${evidenceCount}`);
  parts.push(`scope: ${hasScope ? 'set' : 'missing'}`);
  return parts.join(' · ');
}

export function formatTaskCount(count: number): string {
  return `${count} ${pluralize(count, 'task')}`;
}

function inferValidationStatus(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): NonNullable<PlanTaskReviewMetadata['validationStatus']> {
  if (metadata?.validationStatus) return metadata.validationStatus;
  if (issues.some((issue) => issue.severity === 'error')) return 'fail';
  if (issues.some((issue) => issue.severity === 'warning')) return 'warn';
  return task.tests.length > 0 ? 'pass' : 'pending';
}

function inferRisk(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): PlanReviewRisk {
  if (metadata?.risk) return metadata.risk;
  if (issues.some((issue) => issue.severity === 'error')) return 'high';
  if (task.action === 'modify' || issues.some((issue) => issue.severity === 'warning'))
    return 'medium';
  return 'low';
}

export function formatContextFit(metadata?: PlanTaskReviewMetadata | undefined): string {
  const fit = metadata?.contextFit ?? 'pending';
  const status = metadata?.estimateStatus;
  const statusText = STALE_ESTIMATE_STATUSES.has(status) ? ` estimate ${status}` : '';
  if (metadata?.estimatedTokens === undefined) return `${fit}${statusText}`;
  if (metadata.contextLength === undefined)
    return `${fit} ${metadata.estimatedTokens}${statusText}`;
  return `${fit} ${metadata.estimatedTokens}/${metadata.contextLength}${statusText}`;
}

export function formatTaskReviewLine(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): string {
  const validationStatus = inferValidationStatus(task, issues, metadata);
  const risk = inferRisk(task, issues, metadata);
  const markers = [
    metadata?.conflict ? `conflict ${metadata.conflict.files.join(',')}` : null,
    metadata?.stale ? 'stale' : null,
    metadata?.checkpoint ? `checkpoint ${metadata.checkpoint}` : null,
  ].filter((part): part is string => part !== null);

  return [
    `worker ${metadata?.workerProfile ?? 'auto'}`,
    `cost ${metadata?.selectedCostTier ?? 'pending'}`,
    `fit ${formatContextFit(metadata)}`,
    `validation ${task.tests.length} ${validationStatus}`,
    `risk ${risk}`,
    ...markers,
  ].join(' · ');
}

export function formatPlanReviewSummary(
  tasks: Task[],
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
): string {
  const values = tasks
    .map((task) => metadata.get(task.id))
    .filter((item): item is PlanTaskReviewMetadata => item !== undefined);
  const overflowCount = values.filter((item) => item.contextFit === 'overflow').length;
  const tightCount = values.filter((item) => item.contextFit === 'tight').length;
  const fitCount = values.filter((item) => item.contextFit === 'fits').length;
  const tokenTotal = values.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
  const workers = uniqueSorted(
    values
      .map((item) => item.workerProfile)
      .filter((worker): worker is string => worker !== undefined),
    { nonEmpty: true },
  );
  const costTierCounts = new Map<ImplementerCostTier, number>();
  for (const item of values) {
    if (item.selectedCostTier === undefined) continue;
    costTierCounts.set(item.selectedCostTier, (costTierCounts.get(item.selectedCostTier) ?? 0) + 1);
  }

  const fitParts = [
    fitCount > 0 ? `${fitCount} fit` : null,
    tightCount > 0 ? `${tightCount} tight` : null,
    overflowCount > 0 ? `${overflowCount} overflow` : null,
  ].filter((part): part is string => part !== null);

  const context = fitParts.length > 0 ? fitParts.join(' · ') : 'fit pending';
  const costParts = COST_TIER_ORDER.map((tier) => {
    const count = costTierCounts.get(tier) ?? 0;
    return count > 0 ? `${tier}:${count}` : null;
  }).filter((part): part is string => part !== null);
  const cost = costParts.length > 0 ? `cost ${costParts.join(',')}` : 'cost pending';
  const tokens = tokenTotal > 0 ? `tokens ${tokenTotal}` : 'tokens pending';
  const workerText = workers.length > 0 ? `workers ${workers.join(',')}` : 'workers auto';
  return `context ${context} · ${cost} · ${tokens} · ${workerText}`;
}
