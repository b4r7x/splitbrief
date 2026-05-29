import type { Task } from '../../../core/schemas/task.js';
import { buildRoutingPreviewMetadata } from '../../../engine/facades/routing-preview.js';
import { configStore } from '../../../stores/project/config.js';
import type { PlanTaskReviewMetadata } from '../../../stores/workflow/plan-editor.js';

export async function refreshPlanReviewMetadata(
  tasks: Task[],
): Promise<PlanTaskReviewMetadata[] | null> {
  const { config, projectDir } = configStore.get();
  if (!config) return null;
  return buildRoutingPreviewMetadata(tasks, { config, projectDir });
}
