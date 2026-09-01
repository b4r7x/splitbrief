import type { Task } from '../../core/schemas/task.js';
import { buildRoutingPreviewMetadata } from '../../engine/routing-preview.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';

export async function refreshPlanReviewMetadata(
  tasks: Task[],
): Promise<PlanTaskReviewMetadata[] | null> {
  const { config, projectDir } = configStore.get();
  if (!config) return null;
  const detectedContextLength = configStore.getDetectedContextLength();
  return buildRoutingPreviewMetadata(tasks, {
    config,
    projectDir,
    modelCache: modelCacheStore,
    ...(detectedContextLength !== undefined && { detectedContextLength }),
  });
}
