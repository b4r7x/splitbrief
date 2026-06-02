import type { Task, TaskId } from '../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../engine/spec/brief-quality.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import {
  STALE_ESTIMATE_STATUSES,
  hasNoCapableWorker,
  hasStaleOrConflict,
  hasTruncatedContextReason,
} from '../../core/plan-review/predicates.js';

export type PlanReviewScorecardBucket =
  | 'ready'
  | 'routingPending'
  | 'splitOverflow'
  | 'riskyTight'
  | 'staleConflict'
  | 'missingChecks';

export interface PlanReviewScorecardEntry {
  bucket: PlanReviewScorecardBucket;
  label: string;
  count: number;
  taskIds: TaskId[];
}

export interface PlanReviewScorecard {
  ready: PlanReviewScorecardEntry;
  routingPending: PlanReviewScorecardEntry;
  splitOverflow: PlanReviewScorecardEntry;
  riskyTight: PlanReviewScorecardEntry;
  staleConflict: PlanReviewScorecardEntry;
  missingChecks: PlanReviewScorecardEntry;
  buckets: PlanReviewScorecardEntry[];
}

const BUCKET_ORDER: PlanReviewScorecardBucket[] = [
  'ready',
  'routingPending',
  'splitOverflow',
  'riskyTight',
  'staleConflict',
  'missingChecks',
];

const BUCKET_LABELS: Record<PlanReviewScorecardBucket, string> = {
  ready: 'ready',
  routingPending: 'routing pending',
  splitOverflow: 'split/overflow',
  riskyTight: 'risky/tight',
  staleConflict: 'stale/conflict',
  missingChecks: 'missing checks',
};

const SPLIT_OVERFLOW_ISSUES = new Set<BriefQualityIssue['code']>([
  'multi_file_task',
  'missing_type_definitions',
]);

const MISSING_CHECK_ISSUES = new Set<BriefQualityIssue['code']>([
  'missing_validation',
  'vague_validation',
  'missing_evidence',
]);

function issuesForTask(quality: BriefQualityReport | null, taskId: TaskId): BriefQualityIssue[] {
  return quality?.issues.filter((issue) => issue.taskId === taskId) ?? [];
}

function hasIssueCode(
  issues: BriefQualityIssue[],
  codes: ReadonlySet<BriefQualityIssue['code']>,
): boolean {
  return issues.some((issue) => codes.has(issue.code));
}

function hasCurrentTaskEstimate(task: Task, metadata: PlanTaskReviewMetadata): boolean {
  if (metadata.estimatedTokens === undefined) return false;
  return task.action !== 'modify' || metadata.estimateStatus !== undefined;
}

function hasRoutingPendingCondition(
  task: Task,
  metadata: PlanTaskReviewMetadata | undefined,
): boolean {
  if (metadata === undefined) return true;
  if (metadata.stale === true) return true;
  if (metadata.contextFit === undefined) return true;
  if (metadata.workerProfile === undefined && !hasNoCapableWorker(metadata)) return true;
  if (metadata.validationStatus === 'pending') return true;
  if (STALE_ESTIMATE_STATUSES.has(metadata.estimateStatus)) return true;
  return !hasCurrentTaskEstimate(task, metadata);
}

function hasSplitOverflowCondition(
  metadata: PlanTaskReviewMetadata | undefined,
  issues: BriefQualityIssue[],
): boolean {
  return (
    metadata?.contextFit === 'overflow' ||
    (metadata !== undefined && hasNoCapableWorker(metadata)) ||
    hasIssueCode(issues, SPLIT_OVERFLOW_ISSUES)
  );
}

function hasRiskyTightCondition(metadata: PlanTaskReviewMetadata | undefined): boolean {
  if (metadata === undefined) return false;
  if (metadata.contextFit === 'tight') return true;
  if (metadata.risk === 'high') return true;
  if (metadata.validationStatus === 'warn' || metadata.validationStatus === 'fail') return true;
  if (STALE_ESTIMATE_STATUSES.has(metadata.estimateStatus)) return true;
  return hasTruncatedContextReason(metadata);
}

function hasMissingChecksCondition(task: Task, issues: BriefQualityIssue[]): boolean {
  return (
    task.tests.length === 0 ||
    (task.evidence?.length ?? 0) === 0 ||
    hasIssueCode(issues, MISSING_CHECK_ISSUES)
  );
}

function hasErrorIssue(issues: BriefQualityIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function hasReadyCondition(opts: {
  metadata: PlanTaskReviewMetadata | undefined;
  issues: BriefQualityIssue[];
  routingPending: boolean;
  splitOverflow: boolean;
  riskyTight: boolean;
  staleConflict: boolean;
  missingChecks: boolean;
}): boolean {
  const metadata = opts.metadata;
  return (
    metadata !== undefined &&
    !hasErrorIssue(opts.issues) &&
    !opts.routingPending &&
    !opts.splitOverflow &&
    !opts.riskyTight &&
    !opts.staleConflict &&
    !opts.missingChecks &&
    metadata.contextFit === 'fits' &&
    metadata.workerProfile !== undefined &&
    metadata.validationStatus !== 'pending' &&
    metadata.validationStatus !== 'fail'
  );
}

function entry(bucket: PlanReviewScorecardBucket, taskIds: TaskId[]): PlanReviewScorecardEntry {
  return {
    bucket,
    label: `${BUCKET_LABELS[bucket]} ${taskIds.length}`,
    count: taskIds.length,
    taskIds,
  };
}

export function buildPlanReviewScorecard(
  tasks: Task[],
  quality: BriefQualityReport | null,
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
): PlanReviewScorecard {
  const taskIdsByBucket: Record<PlanReviewScorecardBucket, TaskId[]> = {
    ready: [],
    routingPending: [],
    splitOverflow: [],
    riskyTight: [],
    staleConflict: [],
    missingChecks: [],
  };

  for (const task of tasks) {
    const taskMetadata = metadata.get(task.id);
    const issues = issuesForTask(quality, task.id);
    const routingPending = hasRoutingPendingCondition(task, taskMetadata);
    const splitOverflow = hasSplitOverflowCondition(taskMetadata, issues);
    const riskyTight = hasRiskyTightCondition(taskMetadata);
    const staleConflict = hasStaleOrConflict(taskMetadata);
    const missingChecks = hasMissingChecksCondition(task, issues);
    const ready = hasReadyCondition({
      metadata: taskMetadata,
      issues,
      routingPending,
      splitOverflow,
      riskyTight,
      staleConflict,
      missingChecks,
    });

    if (ready) taskIdsByBucket.ready.push(task.id);
    if (routingPending) taskIdsByBucket.routingPending.push(task.id);
    if (splitOverflow) taskIdsByBucket.splitOverflow.push(task.id);
    if (riskyTight) taskIdsByBucket.riskyTight.push(task.id);
    if (staleConflict) taskIdsByBucket.staleConflict.push(task.id);
    if (missingChecks) taskIdsByBucket.missingChecks.push(task.id);
  }

  const ready = entry('ready', taskIdsByBucket.ready);
  const routingPending = entry('routingPending', taskIdsByBucket.routingPending);
  const splitOverflow = entry('splitOverflow', taskIdsByBucket.splitOverflow);
  const riskyTight = entry('riskyTight', taskIdsByBucket.riskyTight);
  const staleConflict = entry('staleConflict', taskIdsByBucket.staleConflict);
  const missingChecks = entry('missingChecks', taskIdsByBucket.missingChecks);
  const entries: Record<PlanReviewScorecardBucket, PlanReviewScorecardEntry> = {
    ready,
    routingPending,
    splitOverflow,
    riskyTight,
    staleConflict,
    missingChecks,
  };

  return {
    ready,
    routingPending,
    splitOverflow,
    riskyTight,
    staleConflict,
    missingChecks,
    buckets: BUCKET_ORDER.map((bucket) => entries[bucket]),
  };
}
