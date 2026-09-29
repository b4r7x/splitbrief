import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { QueuedMessage } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { WorkflowSinks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { Planner } from '../../planners/types.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { join } from 'node:path';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { buildTasksPrompt } from '../../spec/prompts/tasks.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import { runPlannerReview } from '../planner-review.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { readPersistedTasks } from './io.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import { withContinuationLoop } from '../continuation.js';

type RegenerateFromFeedbackCtx = {
  projectDir: string;
  sessionId: string;
  planner: Planner;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  metadata: SpecMetadata;
  signal?: AbortSignal | undefined;
  skillsContext?: string | undefined;
  feedback?: string | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
  commitQueue?: boolean | undefined;
  statusPhase?: Phase | undefined;
  statusSummary?: string | undefined;
  sinks?: WorkflowSinks | undefined;
};

type TasksRegenResult = {
  state: WorkflowState;
  tasks: Task[];
  queuedMessages: readonly QueuedMessage[];
};

async function regenerateFromFeedback(ctx: RegenerateFromFeedbackCtx): Promise<TasksRegenResult> {
  const { projectDir, sessionId, bus, skillsContext } = ctx;
  let { state } = ctx;

  const ownsQueueClaim = ctx.queuedMessages === undefined;
  const queued =
    ctx.queuedMessages === undefined
      ? readQueueForPrompt({ projectDir, sessionId, state })
      : { state, messages: [...ctx.queuedMessages] };
  let transferredQueueClaim = false;
  try {
    state = queued.state;
    const queuedPrefix = queued.messages.length > 0 ? formatDrainedMessages(queued.messages) : '';
    const prefix = ctx.feedback ? `${ctx.feedback}\n\n${queuedPrefix}` : queuedPrefix;

    const spec = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const languageContext = buildProjectLanguageContext(
      projectDir,
      state.discoveredValidation?.language,
    );

    const plan = readSpecFileOrEmpty({ projectDir, sessionId }, PLAN_FILE);
    const persisted = await readPersistedTasks(
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
      (message) => publishWarning({ bus, phase: state.phase, message }),
    );
    const currentTasks = persisted.ok ? persisted.tasks : state.tasks;
    const basePrompt = buildTasksPrompt({
      spec,
      plan,
      languageContext,
      currentTasks,
      skillsContext,
    });
    const result = await runRegenerationReview({
      ctx,
      state,
      prompt: prefix ? prefix + basePrompt : basePrompt,
    });
    state = result.state;
    const tasks = parseTasksStrict(result.text, (message) =>
      publishWarning({ bus, phase: state.phase, message }),
    );
    state = maybeCommitQueue(ctx, state, queued.messages);
    transferredQueueClaim = ownsQueueClaim && ctx.commitQueue === false;
    return { state, tasks, queuedMessages: queued.messages };
  } finally {
    if (ownsQueueClaim && !transferredQueueClaim) {
      releaseQueueMessagesForPrompt({ projectDir, sessionId }, queued.messages);
    }
  }
}

function maybeCommitQueue(
  ctx: RegenerateFromFeedbackCtx,
  state: WorkflowState,
  messages: readonly QueuedMessage[],
): WorkflowState {
  if (ctx.commitQueue === false || messages.length === 0) return state;
  return commitQueueMessagesDrained({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    state,
    messages,
    bus: ctx.bus,
  }).state;
}

async function runRegenerationReview(opts: {
  ctx: RegenerateFromFeedbackCtx;
  state: WorkflowState;
  prompt: string;
}): Promise<{ state: WorkflowState; text: string }> {
  const statusPhase = opts.ctx.statusPhase ?? 'planning';
  const summary = opts.ctx.statusSummary ?? 'regenerating Task Briefs';
  const sinks: WorkflowSinks = opts.ctx.sinks ?? {
    setAbortHandler: () => {},
    setQueueHandler: () => {},
  };
  let state = opts.state;

  publishPlannerStatus(opts.ctx.bus, { ...state, phase: statusPhase }, 'running', {
    call: 'tasks',
  });
  opts.ctx.bus.publish({
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: statusPhase,
    elapsedMs: 0,
    accumulatedTokens: 0,
    phaseHint: summary,
  });

  try {
    const loop = await withContinuationLoop<{ state: WorkflowState; text: string }>({
      ctx: {
        projectDir: opts.ctx.projectDir,
        sessionId: opts.ctx.sessionId,
        callbacks: opts.ctx.callbacks,
        bus: opts.ctx.bus,
        signal: opts.ctx.signal,
        sinks,
      },
      state,
      step: { kind: 'planner', call: 'tasks' },
      onStateChange: (s) => {
        state = s;
      },
      body: ({ signal, partial, steer }) =>
        runPlannerReview({
          planner: opts.ctx.planner,
          prompt:
            partial === undefined && steer === undefined
              ? opts.prompt
              : composeContinuation({ basePrompt: opts.prompt, partial, steer }),
          projectDir: opts.ctx.projectDir,
          sessionId: opts.ctx.sessionId,
          bus: opts.ctx.bus,
          state,
          metadata: opts.ctx.metadata,
          signal,
          returnCandidate: true,
        }),
    });
    return loop.value;
  } finally {
    publishPlannerStatus(opts.ctx.bus, { ...state, phase: statusPhase }, 'done');
  }
}

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
  feedback?: string | undefined;
  skillsContext?: string | undefined;
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
    feedback,
    signal,
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
    skillsContext,
  } = opts;
  const result = await regenerateFromFeedback({
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus,
    state,
    metadata,
    feedback,
    signal,
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
    skillsContext,
  });
  return { state: result.state, tasks: result.tasks, queuedMessages: result.queuedMessages };
}
