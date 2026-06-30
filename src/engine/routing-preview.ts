import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveImplementerProfiles } from '../core/config/accessors/implementer-profiles.js';
import type { Config } from '../core/schemas/config.js';
import type { Task } from '../core/schemas/task.js';
import type {
  PlanReviewEstimateStatus,
  PlanReviewRisk,
  PlanTaskReviewMetadata,
} from '../core/plan-review/types.js';
import { routeTaskToImplementerProfile } from './orchestrator/context-routing/route.js';
import { buildRouteTaskOptions } from './orchestrator/context-routing/route-input.js';
import type { ModelCacheAccessor } from './providers/model/resolution.js';
import { buildProjectLanguageContext } from './spec/prompts/language-context.js';
import { isENOENT } from '../lib/process/errors.js';
import { assertWritablePathConfined } from '../lib/path-confinement.js';

function previewProjectContext(projectDir: string) {
  return { name: 'unknown', dir: projectDir };
}

export function buildRoutingPreviewMetadata(
  tasks: Task[],
  opts: {
    config: Config;
    projectDir: string;
    contextCache?: ModelCacheAccessor | undefined;
    detectedContextLength?: number | undefined;
  },
): Promise<PlanTaskReviewMetadata[]> {
  const context = previewProjectContext(opts.projectDir);
  const profiles = resolveImplementerProfiles(opts.config).profiles;
  const languageContext = buildProjectLanguageContext(opts.projectDir, undefined);

  return Promise.all(
    tasks.map(async (task) => {
      const { task: routingTask, estimateStatus } = await refreshTaskForRoutingPreview(
        task,
        opts.projectDir,
      );
      const decision = routeTaskToImplementerProfile(
        buildRouteTaskOptions({
          task: routingTask,
          context,
          profiles,
          ...(opts.contextCache !== undefined && { contextCache: opts.contextCache }),
          languageContext,
          ...(opts.detectedContextLength !== undefined && {
            detectedContextLength: opts.detectedContextLength,
          }),
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
        ...(decision.selectedCostTier !== undefined && {
          selectedCostTier: decision.selectedCostTier,
        }),
        costPosture: decision.costPosture,
        contextFit: decision.fit,
        estimatedTokens: decision.estimatedTokens,
        ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
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
): Promise<{ task: Task; estimateStatus?: PlanReviewEstimateStatus | undefined }> {
  if (task.action !== 'modify') return { task };

  try {
    assertWritablePathConfined(task.file, projectDir);
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

function routingPreviewReason(
  reason: string,
  estimateStatus?: PlanReviewEstimateStatus | undefined,
): string {
  if (estimateStatus === 'missing-current-code') {
    return `${reason}; review estimate is missing current code because the target file was not readable at review time`;
  }
  if (estimateStatus === 'current-code-unavailable') {
    return `${reason}; review estimate could not refresh current code`;
  }
  return reason;
}
