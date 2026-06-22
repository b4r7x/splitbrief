import type { Config } from '../../../core/schemas/config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../core/plan-review/types.js';
import {
  STALE_ESTIMATE_STATUSES,
  hasNoCapableWorker,
} from '../../../core/plan-review/predicates.js';
import { buildRoutingPreviewMetadata } from '../../routing-preview.js';

export type BriefReadinessBlockKind =
  | 'overflow'
  | 'no-capable-worker'
  | 'stale-conflict'
  | 'routing-pending';

export interface BriefReadinessBlock {
  taskId: TaskId;
  kind: BriefReadinessBlockKind;
  message: string;
  nextAction: string;
}

export interface BriefReadinessGateReport {
  ok: boolean;
  metadata: PlanTaskReviewMetadata[];
  blocks: BriefReadinessBlock[];
}

function hasCurrentTaskEstimate(task: Task, metadata: PlanTaskReviewMetadata): boolean {
  if (metadata.estimatedTokens === undefined) return false;
  return task.action !== 'modify' || metadata.estimateStatus !== undefined;
}

function hasPendingRoutingMetadata(
  task: Task,
  metadata: PlanTaskReviewMetadata | undefined,
): boolean {
  if (metadata === undefined) return true;
  if (metadata.contextFit === undefined) return true;
  if (metadata.workerProfile === undefined && !hasNoCapableWorker(metadata)) return true;
  if (metadata.validationStatus === 'pending') return true;
  return !hasCurrentTaskEstimate(task, metadata);
}

function classifyReadinessBlock(
  task: Task,
  metadata: PlanTaskReviewMetadata | undefined,
): BriefReadinessBlock | null {
  if (metadata?.contextFit === 'overflow') {
    return {
      taskId: task.id,
      kind: 'overflow',
      message: `Task ${task.id} overflows the selected worker context`,
      nextAction: 'split the task or route it to a larger worker',
    };
  }

  if (metadata !== undefined && hasNoCapableWorker(metadata)) {
    return {
      taskId: task.id,
      kind: 'no-capable-worker',
      message: `Task ${task.id} has no capable worker`,
      nextAction: 'route a larger worker or split the task',
    };
  }

  if (
    metadata?.stale === true ||
    metadata?.conflict !== undefined ||
    STALE_ESTIMATE_STATUSES.has(metadata?.estimateStatus)
  ) {
    return {
      taskId: task.id,
      kind: 'stale-conflict',
      message: `Task ${task.id} has stale or conflicting routing context`,
      nextAction: 'resolve the conflict or revise the brief with current code context',
    };
  }

  if (hasPendingRoutingMetadata(task, metadata)) {
    return {
      taskId: task.id,
      kind: 'routing-pending',
      message: `Task ${task.id} has unresolved routing metadata`,
      nextAction: 'refresh routing readiness before approval',
    };
  }

  return null;
}

export function evaluateBriefReadiness(
  tasks: Task[],
  metadata: readonly PlanTaskReviewMetadata[],
): BriefReadinessGateReport {
  const metadataByTask = new Map(metadata.map((item) => [item.taskId, item]));
  const blocks = tasks
    .map((task) => classifyReadinessBlock(task, metadataByTask.get(task.id)))
    .filter((block): block is BriefReadinessBlock => block !== null);

  return { ok: blocks.length === 0, metadata: [...metadata], blocks };
}

export async function runBriefReadinessGate(opts: {
  tasks: Task[];
  config: Config;
  projectDir: string;
}): Promise<BriefReadinessGateReport> {
  const metadata = await buildRoutingPreviewMetadata(opts.tasks, {
    config: opts.config,
    projectDir: opts.projectDir,
  });
  return evaluateBriefReadiness(opts.tasks, metadata);
}

export function firstBriefReadinessBlockMessage(report: BriefReadinessGateReport): string {
  const block = report.blocks[0];
  if (!block) return 'Task Brief readiness failed';
  const suffix = report.blocks.length > 1 ? ` (${report.blocks.length} blocking tasks)` : '';
  return `Task Brief approval blocked: ${block.message}${suffix}. Next best action: ${block.nextAction}.`;
}
