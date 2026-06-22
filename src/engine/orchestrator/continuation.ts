import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { QueuedMessage } from '../../core/schemas/workflow.js';
import type { Task } from '../../core/schemas/task.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import { join } from 'node:path';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { parseTasksStrict } from '../spec/parser.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildProjectLanguageContext } from '../spec/prompts/language-context.js';
import { buildProjectContextMarkdown } from '../planners/context.js';
import { transitionAndSave } from './state-ops.js';
import { publishPlannerStatus, publishWarning } from './events.js';
import { runPlannerReview } from './planner-review.js';
import { commitQueueMessagesDrained, formatDrainedMessages, readQueueForPrompt } from './queue.js';
import { readPersistedTasks } from './planning/io.js';
import type { Phase } from '../../core/schemas/enums.js';

export function buildContinuationPrompt(partialResponse: string, userMessage: string): string {
  const instruction = userMessage.trim() || 'Please continue from where you left off.';
  return `The previous attempt was interrupted. Here is the partial response:\n\n${partialResponse}\n\n${instruction}`;
}

export interface ContinuationLoopCtx {
  projectDir: string;
  sessionId: string;
  /** When execution cwd differs from the real session tree, persist transitions here. */
  persistRef?: { projectDir: string; sessionId: string } | undefined;
  callbacks: OrchestratorCallbacks;
  signal?: AbortSignal | undefined;
  sinks: WorkflowSinks;
}

export interface ContinuationLoopBodyArgs {
  signal: AbortSignal;
  continuationPrompt: string | undefined;
  recordOutput: (text: string) => void;
}

export interface AttemptResult<T> {
  value: T;
  continueIfAborted?: boolean | undefined;
}

export interface WithContinuationLoopOpts<T> {
  ctx: ContinuationLoopCtx;
  state: WorkflowState;
  onStateChange?: ((s: WorkflowState) => void) | undefined;
  body: (args: ContinuationLoopBodyArgs) => Promise<AttemptResult<T>>;
}

export async function withContinuationLoop<T>(
  opts: WithContinuationLoopOpts<T>,
): Promise<{ state: WorkflowState; value: T }> {
  const { ctx, onStateChange, body } = opts;
  const { projectDir, sessionId, callbacks, sinks } = ctx;
  const persistRef = ctx.persistRef ?? { projectDir, sessionId };
  let state = opts.state;
  let continuationPrompt: string | undefined;
  let partialOutput = '';

  const applyState = (next: WorkflowState) => {
    state = next;
    onStateChange?.(next);
  };

  const recordOutput = (text: string) => {
    partialOutput += text;
  };

  const continueAfterAbort = async (
    onContinuationNeeded: NonNullable<OrchestratorCallbacks['onContinuationNeeded']>,
  ): Promise<string> => {
    applyState(transitionAndSave(persistRef, state, { type: 'ABORT_TURN' }));
    const userText = await onContinuationNeeded(partialOutput);
    applyState(transitionAndSave(persistRef, state, { type: 'CONTINUE_TURN' }));
    return buildContinuationPrompt(partialOutput, userText);
  };

  while (true) {
    const callController = new AbortController();
    sinks.setAbortHandler(() => callController.abort());
    partialOutput = '';

    const bodySignal = ctx.signal
      ? AbortSignal.any([ctx.signal, callController.signal])
      : callController.signal;

    let attempt: AttemptResult<T>;
    try {
      attempt = await body({ signal: bodySignal, continuationPrompt, recordOutput });
    } catch (err) {
      sinks.setAbortHandler(null);

      if (callController.signal.aborted && !ctx.signal?.aborted && callbacks.onContinuationNeeded) {
        continuationPrompt = await continueAfterAbort(callbacks.onContinuationNeeded);
        continue;
      }

      throw err;
    }

    sinks.setAbortHandler(null);

    if (
      attempt.continueIfAborted &&
      callController.signal.aborted &&
      !ctx.signal?.aborted &&
      callbacks.onContinuationNeeded
    ) {
      continuationPrompt = await continueAfterAbort(callbacks.onContinuationNeeded);
      continue;
    }

    return { state, value: attempt.value };
  }
}

export type RegenerateFromFeedbackCtx = {
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
  queuedMessages?: readonly QueuedMessage[] | undefined;
  commitQueue?: boolean | undefined;
  statusPhase?: Phase | undefined;
  statusSummary?: string | undefined;
  sinks?: WorkflowSinks | undefined;
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

export async function regenerateFromFeedback(
  kind: 'plan',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult>;
export async function regenerateFromFeedback(
  kind: 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<TasksRegenResult>;
export async function regenerateFromFeedback(
  kind: 'plan' | 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult | TasksRegenResult> {
  const { projectDir, sessionId, bus, skillsContext, planOverride } = ctx;
  let { state } = ctx;

  const queued =
    ctx.queuedMessages === undefined
      ? readQueueForPrompt({ projectDir, sessionId, state })
      : { state, messages: [...ctx.queuedMessages] };
  state = queued.state;
  const prefix = queued.messages.length > 0 ? formatDrainedMessages(queued.messages) : '';

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
      writeTo: PLAN_FILE,
    });
    state = maybeCommitQueue(ctx, result.state, queued.messages);
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
    writeTo: TASKS_FILE,
  });
  const tasks = parseTasksStrict(result.text, (message) =>
    publishWarning({ bus, phase: state.phase, message }),
  );
  state = maybeCommitQueue(ctx, result.state, queued.messages);
  return {
    kind: 'tasks',
    state,
    tasks,
    queuedMessages: queued.messages,
  };
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
  writeTo: typeof PLAN_FILE | typeof TASKS_FILE;
}): Promise<{ state: WorkflowState; text: string }> {
  const statusPhase = opts.ctx.statusPhase ?? 'planning';
  const summary =
    opts.ctx.statusSummary ??
    (opts.kind === 'plan' ? 'regenerating plan from feedback' : 'regenerating Task Briefs');
  const controller = opts.ctx.sinks ? new AbortController() : null;
  const signal = controller
    ? opts.ctx.signal === undefined
      ? controller.signal
      : AbortSignal.any([opts.ctx.signal, controller.signal])
    : opts.ctx.signal;

  if (controller) opts.ctx.sinks?.setAbortHandler(() => controller.abort());
  publishPlannerStatus(opts.ctx.bus, { ...opts.state, phase: statusPhase }, 'running');
  opts.ctx.bus.publish({
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: statusPhase,
    elapsedMs: 0,
    accumulatedTokens: 0,
    phaseHint: summary,
  });

  try {
    return await runPlannerReview({
      planner: opts.ctx.planner,
      prompt: opts.prompt,
      projectDir: opts.ctx.projectDir,
      sessionId: opts.ctx.sessionId,
      bus: opts.ctx.bus,
      state: opts.state,
      metadata: opts.ctx.metadata,
      writeTo: opts.writeTo,
      signal,
    });
  } finally {
    opts.ctx.sinks?.setAbortHandler(null);
    publishPlannerStatus(opts.ctx.bus, { ...opts.state, phase: statusPhase }, 'done');
  }
}
