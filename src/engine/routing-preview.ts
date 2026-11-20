import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveImplementerProfiles } from '../core/config/accessors/implementer-profiles.js';
import { projectName } from '../core/project-meta.js';
import type { Config } from '../core/schemas/config.js';
import type { Task, TaskId } from '../core/schemas/task.js';
import { routeTaskToImplementerProfile } from './orchestrator/context-routing/route.js';
import { buildRouteTaskOptions } from './orchestrator/context-routing/route-input.js';
import type { ModelCacheAccessor } from './providers/model/runtime-snapshot.js';
import { buildProjectLanguageContext } from './spec/prompts/language-context.js';
import type { PlanContext } from './spec/prompts/task.js';
import { isENOENT } from '../utils/errno.js';
import { assertWritablePathConfined } from '../lib/fs/confinement.js';
import type { TaskContextFit, CurrentCodeContextMode } from '../core/schemas/enums.js';
import type { BuildContextOverflow } from './orchestrator/context-routing/types.js';

function previewProjectContext(projectDir: string, skillsContext: string | undefined) {
  return {
    name: projectName(projectDir),
    dir: projectDir,
    ...(skillsContext !== undefined && { skillsContext }),
  };
}

function normalizeTaskFilePath(file: string): string {
  return file.trim().replace(/^\.\//, '');
}

export function buildRoutingPreviewMetadata(
  tasks: Task[],
  opts: {
    config: Config;
    projectDir: string;
    modelCache?: ModelCacheAccessor | undefined;
    detectedContextLength?: number | undefined;
    /** The run's skills block, which every brief prompt the worker receives carries. */
    skillsContext?: string | undefined;
    plan?: PlanContext | undefined;
  },
): Promise<PlanTaskReviewMetadata[]> {
  const context = previewProjectContext(opts.projectDir, opts.skillsContext);
  const profiles = resolveImplementerProfiles(opts.config).profiles;
  const languageContext = buildProjectLanguageContext(opts.projectDir, undefined);

  const plannedCreateIndexes = new Map<string, number>();
  tasks.forEach((task, index) => {
    if (task.action !== 'create') return;
    const normalized = normalizeTaskFilePath(task.suggestedFiles[0]);
    const existing = plannedCreateIndexes.get(normalized);
    if (existing === undefined || index < existing) plannedCreateIndexes.set(normalized, index);
  });

  return Promise.all(
    tasks.map(async (task, index) => {
      const createdAtIndex = plannedCreateIndexes.get(
        normalizeTaskFilePath(task.suggestedFiles[0]),
      );
      const plannedCreateEarlier = createdAtIndex !== undefined && createdAtIndex < index;
      const { task: routingTask, estimateStatus } = await refreshTaskForRoutingPreview(
        task,
        opts.projectDir,
        plannedCreateEarlier,
      );
      const decision = routeTaskToImplementerProfile(
        buildRouteTaskOptions({
          task: routingTask,
          context,
          profiles,
          ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
          languageContext,
          ...(opts.detectedContextLength !== undefined && {
            detectedContextLength: opts.detectedContextLength,
          }),
          plan: opts.plan,
        }),
      );
      const routeBlocked = decision.selectedProfile === undefined;
      const risk: PlanReviewRisk =
        routeBlocked ||
        estimateStatus === 'missing-current-code' ||
        estimateStatus === 'current-code-unavailable'
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
        contextFit: decision.fit,
        estimatedTokens: decision.estimatedTokens,
        ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
        ...(decision.contextOverflow !== undefined && {
          contextOverflow: decision.contextOverflow,
        }),
        ...(estimateStatus !== undefined && { estimateStatus }),
        routingReason,
        ...(routeBlocked && { routingBlockKind: 'no-capable-worker' as const }),
        currentCodeContextMode: decision.currentCodeContextMode,
        currentCodeTruncated: decision.currentCodeTruncated,
        ...(routeBlocked ||
        estimateStatus === 'missing-current-code' ||
        estimateStatus === 'current-code-unavailable'
          ? { validationStatus: 'warn' as const }
          : {}),
        risk,
      };
    }),
  );
}

async function refreshTaskForRoutingPreview(
  task: Task,
  projectDir: string,
  plannedCreateEarlier: boolean,
): Promise<{ task: Task; estimateStatus?: PlanReviewEstimateStatus | undefined }> {
  if (task.action !== 'modify') return { task };

  try {
    assertWritablePathConfined(task.suggestedFiles[0], projectDir);
    const currentCode = await readFile(join(projectDir, task.suggestedFiles[0]), 'utf-8');
    return { task: { ...task, currentCode }, estimateStatus: 'refreshed-current-code' };
  } catch (err) {
    const { currentCode: _staleCurrentCode, ...taskWithoutCurrentCode } = task;
    return {
      task: taskWithoutCurrentCode,
      estimateStatus: isENOENT(err)
        ? plannedCreateEarlier
          ? 'pending-earlier-task'
          : 'missing-current-code'
        : 'current-code-unavailable',
    };
  }
}

function routingPreviewReason(
  reason: string,
  estimateStatus?: PlanReviewEstimateStatus | undefined,
): string {
  if (estimateStatus === 'pending-earlier-task') {
    return `${reason}; review estimate is pending because an earlier task in this plan creates the target file`;
  }
  if (estimateStatus === 'missing-current-code') {
    return `${reason}; review estimate is missing current code because the target file was not readable at review time`;
  }
  if (estimateStatus === 'current-code-unavailable') {
    return `${reason}; review estimate could not refresh current code`;
  }
  return reason;
}

export type PlanReviewRisk = 'low' | 'medium' | 'high';
export type PlanReviewEstimateStatus =
  | 'refreshed-current-code'
  | 'brief-current-code'
  | 'missing-current-code'
  | 'current-code-unavailable'
  | 'pending-earlier-task';

export type PlanReviewRoutingBlockKind = 'no-capable-worker';

export interface PlanTaskReviewMetadata {
  taskId: TaskId;
  workerProfile?: string | undefined;
  contextFit?: TaskContextFit | undefined;
  estimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  contextOverflow?: BuildContextOverflow | undefined;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingReason?: string | undefined;
  routingBlockKind?: PlanReviewRoutingBlockKind | undefined;
  currentCodeContextMode?: CurrentCodeContextMode | undefined;
  currentCodeTruncated?: boolean | undefined;
  validationStatus?: 'pending' | 'pass' | 'warn' | 'fail' | undefined;
  risk?: PlanReviewRisk | undefined;
  stale?: boolean | undefined;
  checkpoint?: string | undefined;
}
