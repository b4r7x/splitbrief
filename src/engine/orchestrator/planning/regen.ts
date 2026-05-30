import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { Planner } from '../../planners/types.js';
import { regenerateFromFeedback } from '../continuation.js';

type RegenerateBaseOptions = {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
};

type RegenerateTasksOptions = RegenerateBaseOptions & {
  planOverride?: string | undefined;
};

type RegeneratePlanAndTasksOptions = RegenerateBaseOptions & {
  skillsContext?: string | undefined;
};

type RegenerateTasksIfNeededOptions = RegenerateBaseOptions & {
  regenerated: boolean;
  tasks: Task[];
};

export async function regenerateTasks(
  opts: RegenerateTasksOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const { projectDir, sessionId, planner, callbacks, bus, state, metadata, planOverride, signal } =
    opts;
  const result = await regenerateFromFeedback('tasks', {
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state,
    metadata,
    planOverride,
    signal,
  });
  return { state: result.state, tasks: result.tasks };
}

export async function regeneratePlanAndTasks(
  opts: RegeneratePlanAndTasksOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const { projectDir, sessionId, planner, callbacks, bus, state, metadata, skillsContext, signal } =
    opts;
  const planRegen = await regenerateFromFeedback('plan', {
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state,
    metadata,
    skillsContext,
    signal,
  });
  const taskRegen = await regenerateFromFeedback('tasks', {
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state: planRegen.state,
    metadata,
    planOverride: planRegen.plan,
    signal,
  });
  return { state: taskRegen.state, tasks: taskRegen.tasks };
}

export async function regenerateTasksIfNeeded(
  opts: RegenerateTasksIfNeededOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!opts.regenerated) return { state: opts.state, tasks: opts.tasks };
  return regenerateTasks(opts);
}
