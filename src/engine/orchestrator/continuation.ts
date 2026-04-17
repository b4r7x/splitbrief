import type { WorkflowState, Task } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { Planner } from '../planners/types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE } from '../../core/paths.js';
import { parseTasks } from '../spec/parser.js';
import { buildPlanPrompt } from '../spec/prompts/plan.js';
import { buildTasksPrompt } from '../spec/prompts/tasks.js';
import { buildProjectContextMarkdown } from '../planners/context.js';
import { transitionAndSave } from './state-ops.js';
import { runPlannerReview } from './planner-review.js';
import { drainQueue, formatDrainedMessages } from './queue.js';

export function buildContinuationPrompt(partialResponse: string, userMessage: string): string {
  const instruction = userMessage.trim() || 'Please continue from where you left off.';
  return `The previous attempt was interrupted. Here is the partial response:\n\n${partialResponse}\n\n${instruction}`;
}

export interface ContinuationLoopCtx {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  signal?: AbortSignal | undefined;
  sinks: WorkflowSinks;
}

export interface ContinuationLoopBodyArgs {
  /** Per-call signal that is aborted when the user requests to interrupt the current turn. */
  signal: AbortSignal;
  /** Continuation prompt built from the previous partial output + user text, or undefined on the first attempt. */
  continuationPrompt: string | undefined;
  /** Records a chunk of output to the rolling partial buffer used by the continuation prompt. */
  recordOutput: (text: string) => void;
}

/**
 * The outcome of a single attempt. `continueIfAborted` instructs the loop to re-invoke the body
 * with a continuation prompt when the per-call signal aborted and a continuation handler exists.
 * Callers that only produce a value via throw (planners) pass `continueIfAborted: false`.
 */
export interface AttemptResult<T> {
  value: T;
  continueIfAborted?: boolean | undefined;
}

export interface WithContinuationLoopOpts<T> {
  ctx: ContinuationLoopCtx;
  state: WorkflowState;
  /** Invoked after each state transition inside the loop (ABORT_TURN / CONTINUE_TURN). */
  onStateChange?: ((s: WorkflowState) => void) | undefined;
  /**
   * Body executed on every attempt. Throwing an abort-error enters continuation mode (when a
   * handler exists); any other throw propagates. Returning a value exits the loop unless the
   * body opts in to `continueIfAborted` and the per-call signal was aborted.
   */
  body: (args: ContinuationLoopBodyArgs) => Promise<AttemptResult<T>>;
}

/**
 * Runs a planner/implementer call inside a per-attempt abort controller, wires the abort handler
 * onto the shared sinks, and re-invokes the body with a continuation prompt when the user aborts
 * a turn and provides follow-up instructions. The controller/sink is cleaned up on every exit path.
 */
export async function withContinuationLoop<T>(opts: WithContinuationLoopOpts<T>): Promise<{ state: WorkflowState; value: T }> {
  const { ctx, onStateChange, body } = opts;
  const { projectDir, sessionId, callbacks, sinks } = ctx;
  let state = opts.state;
  let continuationPrompt: string | undefined;
  let partialOutput = '';

  const applyState = (next: WorkflowState) => {
    state = next;
    onStateChange?.(next);
  };

  const recordOutput = (text: string) => { partialOutput += text; };

  while (true) {
    const callController = new AbortController();
    sinks.setAbortHandler(() => callController.abort());
    partialOutput = '';

    let attempt: AttemptResult<T>;
    try {
      attempt = await body({ signal: callController.signal, continuationPrompt, recordOutput });
    } catch (err) {
      sinks.setAbortHandler(null);

      if (callController.signal.aborted && !ctx.signal?.aborted && callbacks.onContinuationNeeded) {
        applyState(transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' }));
        const userText = await callbacks.onContinuationNeeded(partialOutput);
        applyState(transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' }));
        continuationPrompt = buildContinuationPrompt(partialOutput, userText);
        continue;
      }

      throw err;
    }

    sinks.setAbortHandler(null);

    if (attempt.continueIfAborted && callController.signal.aborted && !ctx.signal?.aborted && callbacks.onContinuationNeeded) {
      applyState(transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' }));
      const userText = await callbacks.onContinuationNeeded(partialOutput);
      applyState(transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' }));
      continuationPrompt = buildContinuationPrompt(partialOutput, userText);
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
  state: WorkflowState;
  metadata: SpecMetadata;
  skillsContext?: string | undefined;
  /** When provided, used as the plan text for tasks regeneration (avoids reading PLAN_FILE from disk). */
  planOverride?: string | undefined;
};

type PlanRegenResult = { kind: 'plan'; state: WorkflowState; plan: string };
type TasksRegenResult = { kind: 'tasks'; state: WorkflowState; tasks: Task[] };

/**
 * Unified regeneration for plan.md or tasks.md driven by the current spec/plan on disk.
 * Drains any queued messages before calling the planner, then writes the resulting artifact
 * to disk via runPlannerReview. Callers handle emitting higher-level orchestrator events
 * around the regeneration.
 */
export async function regenerateFromFeedback(kind: 'plan', ctx: RegenerateFromFeedbackCtx): Promise<PlanRegenResult>;
export async function regenerateFromFeedback(kind: 'tasks', ctx: RegenerateFromFeedbackCtx): Promise<TasksRegenResult>;
export async function regenerateFromFeedback(
  kind: 'plan' | 'tasks',
  ctx: RegenerateFromFeedbackCtx,
): Promise<PlanRegenResult | TasksRegenResult> {
  const { projectDir, sessionId, planner, callbacks, metadata, skillsContext, planOverride } = ctx;
  let { state } = ctx;

  const drain = drainQueue(projectDir, sessionId, state, callbacks);
  state = drain.state;
  const prefix = drain.messages.length > 0 ? formatDrainedMessages(drain.messages) : '';

  const spec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);

  if (kind === 'plan') {
    const projectContext = await buildProjectContextMarkdown(projectDir);
    const basePrompt = buildPlanPrompt({ content: spec, hasClarifications: spec.includes('## Clarifications') }, projectContext, skillsContext);
    const result = await runPlannerReview({
      planner,
      prompt: prefix ? prefix + basePrompt : basePrompt,
      projectDir,
      sessionId,
      callbacks,
      state,
      metadata,
      writeTo: PLAN_FILE,
    });
    return { kind: 'plan', state: result.state, plan: result.text };
  }

  const plan = planOverride ?? readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
  const basePrompt = buildTasksPrompt(spec, plan);
  const result = await runPlannerReview({
    planner,
    prompt: prefix ? prefix + basePrompt : basePrompt,
    projectDir,
    sessionId,
    callbacks,
    state,
    metadata,
    writeTo: TASKS_FILE,
  });
  return { kind: 'tasks', state: result.state, tasks: parseTasks(result.text) };
}
