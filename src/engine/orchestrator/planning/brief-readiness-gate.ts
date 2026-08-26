import type { Config } from '../../../core/schemas/config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../../core/plan-review/types.js';
import {
  BLOCKING_ESTIMATE_STATUSES,
  hasNoCapableWorker,
} from '../../../core/plan-review/predicates.js';
import { buildRoutingPreviewMetadata } from '../../routing-preview.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { BRIEF_READINESS_FILE } from '../../../core/paths.js';
import { writeSpecFile, type SpecFileRef } from '../../../core/paths-io.js';

export type BriefReadinessBlockKind = 'overflow' | 'no-capable-worker' | 'stale-conflict';

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
    BLOCKING_ESTIMATE_STATUSES.has(metadata?.estimateStatus)
  ) {
    return {
      taskId: task.id,
      kind: 'stale-conflict',
      message: `Task ${task.id} has stale or conflicting routing context`,
      nextAction: 'resolve the conflict or revise the brief with current code context',
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
  modelCache?: ModelCacheAccessor | undefined;
  detectedContextLength?: number | undefined;
}): Promise<BriefReadinessGateReport> {
  const metadata = await buildRoutingPreviewMetadata(opts.tasks, {
    config: opts.config,
    projectDir: opts.projectDir,
    ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
  });
  return evaluateBriefReadiness(opts.tasks, metadata);
}

export function writeBriefReadiness(ref: SpecFileRef, report: BriefReadinessGateReport): void {
  writeSpecFile(ref, BRIEF_READINESS_FILE, JSON.stringify(report, null, 2), null);
}

export async function runBriefReadinessGateAndReport(opts: {
  tasks: Task[];
  config: Config;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  phase: Phase;
  modelCache?: ModelCacheAccessor | undefined;
  detectedContextLength?: number | undefined;
}): Promise<BriefReadinessGateReport> {
  const { tasks, projectDir, sessionId, bus, phase } = opts;
  const report = await runBriefReadinessGate(opts);
  writeBriefReadiness({ projectDir, sessionId }, report);
  if (report.ok) {
    bus.publish({
      type: 'brief_readiness_passed',
      ts: Date.now(),
      phase,
      taskCount: tasks.length,
    });
  } else {
    bus.publish({
      type: 'brief_readiness_blocked',
      ts: Date.now(),
      phase,
      taskCount: tasks.length,
      blockedCount: report.blocks.length,
      blockedTaskIds: report.blocks.map((block) => block.taskId),
      kinds: [...new Set(report.blocks.map((block) => block.kind))],
    });
  }
  return report;
}

export function formatBriefReadinessBlocks(report: BriefReadinessGateReport): string {
  const firstBlock = report.blocks[0];
  if (!firstBlock) return '';
  const counts = new Map<BriefReadinessBlockKind, number>();
  for (const block of report.blocks) counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
  const kinds = [...counts]
    .toSorted(
      ([leftKind, leftCount], [rightKind, rightCount]) =>
        rightCount - leftCount || leftKind.localeCompare(rightKind),
    )
    .map(([kind, count]) => `${kind} (${count})`)
    .join(', ');
  const taskIds = report.blocks.map((block) => block.taskId);
  const shown = taskIds.slice(0, 8).join(', ');
  const remainder = taskIds.length > 8 ? ` (+${taskIds.length - 8} more)` : '';
  return (
    `Task Brief approval blocked: ${report.blocks.length} of ${report.metadata.length} tasks ` +
    `blocked (${kinds}). Blocked tasks: ${shown}${remainder}. Next best action: ${firstBlock.nextAction}.`
  );
}
