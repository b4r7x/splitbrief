import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile } from '../../../engine/orchestrator/context-routing/route.js';
import { buildProjectLanguageContext } from '../../../engine/spec/prompts/language-context.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { configStore } from '../../../stores/project/config.js';
import { uniqueSorted } from '../../../utils/collections.js';
import type { PlanReviewCostTier, PlanReviewEstimateStatus, PlanReviewRisk, PlanTaskReviewMetadata } from '../../../stores/workflow/plan-editor.js';

const COST_TIER_ORDER: PlanReviewCostTier[] = ['local', 'cheap', 'standard', 'frontier', 'unknown'];

export function formatQualityDisplay(quality: BriefQualityReport | null): string {
  if (quality === null) return 'quality n/a';
  return `quality ${quality.score.toFixed(2)}`;
}

export function hasTaskReviewWarning(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): boolean {
  return issues.some(i => i.severity === 'error' || i.severity === 'warning')
    || hasBlockingReviewState(metadata);
}

function hasBlockingReviewState(metadata?: PlanTaskReviewMetadata | undefined): boolean {
  return metadata?.contextFit === 'overflow'
    || (metadata !== undefined && metadata.workerProfile === undefined)
    || metadata?.estimateStatus === 'missing-current-code'
    || metadata?.estimateStatus === 'current-code-unavailable'
    || metadata?.validationStatus === 'fail'
    || metadata?.validationStatus === 'warn'
    || metadata?.stale
    || metadata?.conflict !== undefined;
}

export function getTaskStatusSymbol(
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): '⚠' | '✓' {
  return issues.some(i => i.severity === 'error') || hasBlockingReviewState(metadata) ? '⚠' : '✓';
}

export function buildTaskDetailParts(task: Task): string {
  const validationCount = task.tests.length;
  const evidenceCount = task.evidence?.length ?? 0;
  const hasScope = (task.scope?.inBounds?.length ?? 0) > 0 || (task.scope?.outOfBounds?.length ?? 0) > 0;
  const parts: string[] = [];
  if (validationCount > 0) parts.push(`validation: ${validationCount} check${validationCount === 1 ? '' : 's'}`);
  if (evidenceCount > 0) parts.push(`evidence: ${evidenceCount}`);
  parts.push(`scope: ${hasScope ? 'set' : 'missing'}`);
  return parts.join(' · ');
}

export function formatTaskCount(count: number): string {
  return `${count} task${count === 1 ? '' : 's'}`;
}

function inferValidationStatus(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): NonNullable<PlanTaskReviewMetadata['validationStatus']> {
  if (metadata?.validationStatus) return metadata.validationStatus;
  if (issues.some(issue => issue.severity === 'error')) return 'fail';
  if (issues.some(issue => issue.severity === 'warning')) return 'warn';
  return task.tests.length > 0 ? 'pass' : 'pending';
}

function inferRisk(
  task: Task,
  issues: BriefQualityIssue[],
  metadata?: PlanTaskReviewMetadata | undefined,
): PlanReviewRisk {
  if (metadata?.risk) return metadata.risk;
  if (issues.some(issue => issue.severity === 'error')) return 'high';
  if (task.action === 'modify' || issues.some(issue => issue.severity === 'warning')) return 'medium';
  return 'low';
}

export function formatContextFit(metadata?: PlanTaskReviewMetadata | undefined): string {
  const fit = metadata?.contextFit ?? 'pending';
  const status = metadata?.estimateStatus;
  const statusText = status === 'missing-current-code' || status === 'current-code-unavailable'
    ? ` estimate ${status}`
    : '';
  if (metadata?.estimatedTokens === undefined) return `${fit}${statusText}`;
  if (metadata.contextLength === undefined) return `${fit} ${metadata.estimatedTokens}${statusText}`;
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
  const values = tasks.map(task => metadata.get(task.id)).filter((item): item is PlanTaskReviewMetadata => item !== undefined);
  const overflowCount = values.filter(item => item.contextFit === 'overflow').length;
  const tightCount = values.filter(item => item.contextFit === 'tight').length;
  const fitCount = values.filter(item => item.contextFit === 'fits').length;
  const tokenTotal = values.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
  const workers = uniqueSorted(
    values.map(item => item.workerProfile).filter((worker): worker is string => worker !== undefined),
    { nonEmpty: true },
  );
  const costTierCounts = new Map<PlanReviewCostTier, number>();
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
  const costParts = COST_TIER_ORDER
    .map(tier => {
      const count = costTierCounts.get(tier) ?? 0;
      return count > 0 ? `${tier}:${count}` : null;
    })
    .filter((part): part is string => part !== null);
  const cost = costParts.length > 0 ? `cost ${costParts.join(',')}` : 'cost pending';
  const tokens = tokenTotal > 0 ? `tokens ${tokenTotal}` : 'tokens pending';
  const workerText = workers.length > 0 ? `workers ${workers.join(',')}` : 'workers auto';
  return `context ${context} · ${cost} · ${tokens} · ${workerText}`;
}

export function buildRoutingPreviewMetadata(
  tasks: Task[],
  opts: { config: Config; projectDir: string },
): Promise<PlanTaskReviewMetadata[]> {
  const context: ProjectContext = {
    name: 'unknown',
    dir: opts.projectDir,
    runtime: 'node',
    testCommand: opts.config.validation.testCommand ?? 'npm test',
  };
  const profiles = resolveImplementerProfiles(opts.config).profiles;

  return Promise.all(tasks.map(async task => {
    const { task: routingTask, estimateStatus } = await refreshTaskForRoutingPreview(task, opts.projectDir);
    const decision = routeTaskToImplementerProfile({
      task: routingTask,
      context,
      profiles,
      languageContext: buildProjectLanguageContext(opts.projectDir, undefined),
    });
    const routeBlocked = decision.selectedProfile === undefined;
    const risk: PlanReviewRisk = routeBlocked || estimateStatus === 'missing-current-code' || estimateStatus === 'current-code-unavailable'
      ? 'high'
      : decision.fit === 'overflow'
      ? 'high'
      : routingTask.action === 'modify' || decision.fit === 'tight'
        ? 'medium'
        : 'low';
    const routingReason = routingPreviewReason(decision.reason, estimateStatus);

    return {
      taskId: routingTask.id,
      ...(decision.selectedProfile !== undefined && { workerProfile: decision.selectedProfile }),
      ...(decision.selectedCostTier !== undefined && { selectedCostTier: decision.selectedCostTier }),
      costPosture: decision.costPosture,
      contextFit: decision.fit,
      estimatedTokens: decision.estimatedTokens,
      ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
      ...(estimateStatus !== undefined && { estimateStatus }),
      routingReason,
      ...(routeBlocked || estimateStatus === 'missing-current-code' || estimateStatus === 'current-code-unavailable'
        ? { validationStatus: 'warn' as const }
        : {}),
      risk,
    };
  }));
}

export async function refreshTaskForRoutingPreview(
  task: Task,
  projectDir: string,
): Promise<{ task: Task; estimateStatus?: PlanReviewEstimateStatus | undefined }> {
  if (task.action !== 'modify') return { task };

  try {
    const currentCode = await readFile(join(projectDir, task.file), 'utf-8');
    return { task: { ...task, currentCode }, estimateStatus: 'refreshed-current-code' };
  } catch (err) {
    const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
    return {
      task: taskWithoutCurrentCode,
      estimateStatus: isENOENT(err) ? 'missing-current-code' : 'current-code-unavailable',
    };
  }
}

function routingPreviewReason(reason: string, estimateStatus?: PlanReviewEstimateStatus | undefined): string {
  if (estimateStatus === 'missing-current-code') {
    return `${reason}; review estimate is missing current code because the target file was not readable at review time`;
  }
  if (estimateStatus === 'current-code-unavailable') {
    return `${reason}; review estimate could not refresh current code`;
  }
  return reason;
}

export async function refreshPlanReviewMetadata(tasks: Task[]): Promise<PlanTaskReviewMetadata[] | null> {
  const { config, projectDir } = configStore.get();
  if (!config) return null;
  return buildRoutingPreviewMetadata(tasks, { config, projectDir });
}
