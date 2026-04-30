import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { Planner } from '../../planners/types.js';
import { regenerateFromFeedback } from '../continuation.js';

export async function regenerateTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  metadata: SpecMetadata,
  planOverride?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const result = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, bus, state, metadata, planOverride,
  });
  return { state: result.state, tasks: result.tasks };
}

export async function regeneratePlanAndTasks(
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  metadata: SpecMetadata,
  skillsContext?: string,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const planRegen = await regenerateFromFeedback('plan', {
    projectDir, sessionId, planner, callbacks, bus, state, metadata, skillsContext,
  });
  const taskRegen = await regenerateFromFeedback('tasks', {
    projectDir, sessionId, planner, callbacks, bus, state: planRegen.state, metadata, planOverride: planRegen.plan,
  });
  return { state: taskRegen.state, tasks: taskRegen.tasks };
}

export async function regenerateTasksIfNeeded(
  regenerated: boolean,
  projectDir: string,
  sessionId: string,
  planner: Planner,
  callbacks: OrchestratorCallbacks,
  bus: EventBus,
  state: WorkflowState,
  tasks: Task[],
  metadata: SpecMetadata,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!regenerated) return { state, tasks };
  return regenerateTasks(projectDir, sessionId, planner, callbacks, bus, state, metadata);
}
