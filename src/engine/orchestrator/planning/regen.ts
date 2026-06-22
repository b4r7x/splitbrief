import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { WorkflowSinks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { Planner } from '../../planners/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { regenerateFromFeedback } from '../continuation.js';
import { commitQueueMessagesDrained, readQueueForPrompt } from '../queue.js';

type RegenerateBaseOptions = {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
  commitQueue?: boolean | undefined;
  statusPhase?: Phase | undefined;
  statusSummary?: string | undefined;
  sinks?: WorkflowSinks | undefined;
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

export async function regenerateTasks(opts: RegenerateTasksOptions): Promise<{
  state: WorkflowState;
  tasks: Task[];
  queuedMessages: readonly QueuedMessage[];
}> {
  const {
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state,
    metadata,
    planOverride,
    signal,
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
  } = opts;
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
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
  });
  return { state: result.state, tasks: result.tasks, queuedMessages: result.queuedMessages };
}

export async function regeneratePlanAndTasks(
  opts: RegeneratePlanAndTasksOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const { projectDir, sessionId, planner, callbacks, bus, state, metadata, skillsContext, signal } =
    opts;
  const queued = readQueueForPrompt({ projectDir, sessionId, state });
  const planRegen = await regenerateFromFeedback('plan', {
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state: queued.state,
    metadata,
    skillsContext,
    signal,
    queuedMessages: queued.messages,
    commitQueue: false,
    sinks: opts.sinks,
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
    queuedMessages: [],
    commitQueue: false,
    sinks: opts.sinks,
  });
  const nextState =
    queued.messages.length === 0
      ? taskRegen.state
      : commitQueueMessagesDrained({
          projectDir,
          sessionId,
          state: taskRegen.state,
          messages: queued.messages,
          bus,
        }).state;
  return { state: nextState, tasks: taskRegen.tasks };
}

export async function regenerateTasksIfNeeded(
  opts: RegenerateTasksIfNeededOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!opts.regenerated) return { state: opts.state, tasks: opts.tasks };
  return regenerateTasks(opts);
}
