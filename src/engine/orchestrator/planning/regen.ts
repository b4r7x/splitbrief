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
import { buildPlanPrompt } from '../../spec/prompts/plan.js';
import { buildTasksPrompt } from '../../spec/prompts/tasks.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { buildProjectContextMarkdown } from '../../planners/context.js';
import { publishPlannerStatus, publishWarning } from '../events.js';
import { runPlannerReview, type BriefRecoveryReviewOptions } from '../planner-review.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { readPersistedTasks } from './io.js';
import { composeSteeredPrompt } from '../../implementers/types.js';
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
  planOverride?: string | undefined;
  feedback?: string | undefined;
  queuedMessages?: readonly QueuedMessage[] | undefined;
  commitQueue?: boolean | undefined;
  statusPhase?: Phase | undefined;
  statusSummary?: string | undefined;
  sinks?: WorkflowSinks | undefined;
  briefRecovery?: BriefRecoveryReviewOptions | undefined;
};

type PlanRegenResult = {
  kind: 'plan';
  state: WorkflowState;
  plan: string;
  queuedMessages: readonly QueuedMessage[];
};
type TasksRegenResult = {
  kind: 'tasks';
  state: WorkflowState;
  tasks: Task[];
  queuedMessages: readonly QueuedMessage[];
};

async function regenerateFromFeedback(
  kind: 'plan',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult>;
async function regenerateFromFeedback(
  kind: 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<TasksRegenResult>;
async function regenerateFromFeedback(
  kind: 'plan' | 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult | TasksRegenResult> {
  const { projectDir, sessionId, bus, skillsContext, planOverride } = ctx;
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

    if (kind === 'plan') {
      const projectContext = await buildProjectContextMarkdown(projectDir);
      const basePrompt = buildPlanPrompt(
        { content: spec, hasClarifications: spec.includes('## Clarifications') },
        projectContext,
        skillsContext,
        languageContext,
      );
      const result = await runRegenerationReview({
        kind,
        ctx,
        state,
        prompt: prefix ? prefix + basePrompt : basePrompt,
      });
      state = result.state;
      state = maybeCommitQueue(ctx, state, queued.messages);
      transferredQueueClaim = ownsQueueClaim && ctx.commitQueue === false;
      return { kind: 'plan', state, plan: result.text, queuedMessages: queued.messages };
    }

    const plan = planOverride ?? readSpecFileOrEmpty({ projectDir, sessionId }, PLAN_FILE);
    const persisted = await readPersistedTasks(
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
      (message) => publishWarning({ bus, phase: state.phase, message }),
    );
    const currentTasks = persisted.ok ? persisted.tasks : state.tasks;
    const basePrompt = buildTasksPrompt(spec, plan, languageContext, currentTasks);
    const result = await runRegenerationReview({
      kind,
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
    return {
      kind: 'tasks',
      state,
      tasks,
      queuedMessages: queued.messages,
    };
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
  kind: 'plan' | 'tasks';
  ctx: RegenerateFromFeedbackCtx;
  state: WorkflowState;
  prompt: string;
}): Promise<{ state: WorkflowState; text: string }> {
  const statusPhase = opts.ctx.statusPhase ?? 'planning';
  const summary =
    opts.ctx.statusSummary ??
    (opts.kind === 'plan' ? 'regenerating plan from feedback' : 'regenerating Task Briefs');
  const sinks: WorkflowSinks = opts.ctx.sinks ?? {
    setAbortHandler: () => {},
    setQueueHandler: () => {},
  };
  let state = opts.state;

  publishPlannerStatus(opts.ctx.bus, { ...state, phase: statusPhase }, 'running');
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
        ...(opts.ctx.briefRecovery === undefined
          ? {}
          : {
              briefRecovery: true,
              operationId: opts.ctx.briefRecovery.operationId,
              noAutomaticContinuation: true,
            }),
      },
      state,
      onStateChange: (s) => {
        state = s;
      },
      body: ({ signal, continuationPrompt, steer }) =>
        runPlannerReview({
          planner: opts.ctx.planner,
          prompt: composeSteeredPrompt(continuationPrompt ?? opts.prompt, steer),
          projectDir: opts.ctx.projectDir,
          sessionId: opts.ctx.sessionId,
          bus: opts.ctx.bus,
          state,
          metadata: opts.ctx.metadata,
          signal,
          briefRecovery: opts.ctx.briefRecovery,
          ...(opts.kind === 'plan' ? { writeTo: PLAN_FILE } : { returnCandidate: true }),
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
  planOverride?: string | undefined;
  feedback?: string | undefined;
  briefRecovery?: BriefRecoveryReviewOptions | undefined;
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
    feedback,
    signal,
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
    briefRecovery,
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
    feedback,
    signal,
    queuedMessages,
    commitQueue,
    statusPhase,
    statusSummary,
    sinks,
    briefRecovery,
  });
  return { state: result.state, tasks: result.tasks, queuedMessages: result.queuedMessages };
}

export async function regeneratePlanAndTasks(
  opts: RegeneratePlanAndTasksOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  const { projectDir, sessionId, planner, callbacks, bus, state, metadata, skillsContext, signal } =
    opts;
  const queued = readQueueForPrompt({ projectDir, sessionId, state });
  try {
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
  } finally {
    releaseQueueMessagesForPrompt({ projectDir, sessionId }, queued.messages);
  }
}

export async function regenerateTasksIfNeeded(
  opts: RegenerateTasksIfNeededOptions,
): Promise<{ state: WorkflowState; tasks: Task[] }> {
  if (!opts.regenerated) return { state: opts.state, tasks: opts.tasks };
  return regenerateTasks(opts);
}
