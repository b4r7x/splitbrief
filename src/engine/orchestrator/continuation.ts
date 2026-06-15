import type { WorkflowState } from '../../core/schemas/workflow.js';
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
import { publishWarning } from './events.js';
import { runPlannerReview } from './planner-review.js';
import { drainQueue, formatDrainedMessages } from './queue.js';
import { readPersistedTasks } from './planning/io.js';

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
};

type PlanRegenResult = { kind: 'plan'; state: WorkflowState; plan: string };
type TasksRegenResult = { kind: 'tasks'; state: WorkflowState; tasks: Task[] };

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
  const { projectDir, sessionId, planner, bus, metadata, skillsContext, planOverride } = ctx;
  let { state } = ctx;

  const drain = drainQueue(projectDir, sessionId, state, bus);
  state = drain.state;
  const prefix = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';

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
    const result = await runPlannerReview({
      planner,
      prompt: prefix ? prefix + basePrompt : basePrompt,
      projectDir,
      sessionId,
      bus,
      state,
      metadata,
      writeTo: PLAN_FILE,
      signal: ctx.signal,
    });
    return { kind: 'plan', state: result.state, plan: result.text };
  }

  const plan = planOverride ?? readSpecFileOrEmpty({ projectDir, sessionId }, PLAN_FILE);
  const persisted = await readPersistedTasks(
    join(sessionDir(projectDir, sessionId), TASKS_FILE),
    (message) => publishWarning({ bus, phase: state.phase }, message),
  );
  const currentTasks = persisted.ok ? persisted.tasks : state.tasks;
  const basePrompt = buildTasksPrompt(spec, plan, languageContext, currentTasks);
  const result = await runPlannerReview({
    planner,
    prompt: prefix ? prefix + basePrompt : basePrompt,
    projectDir,
    sessionId,
    bus,
    state,
    metadata,
    writeTo: TASKS_FILE,
    signal: ctx.signal,
  });
  return {
    kind: 'tasks',
    state: result.state,
    tasks: parseTasksStrict(result.text, (message) =>
      publishWarning({ bus, phase: state.phase }, message),
    ),
  };
}
