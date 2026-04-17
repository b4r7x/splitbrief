import type { WorkflowState } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { WorkflowSinks } from './types.js';
import { transitionAndSave } from './helpers.js';
import { buildContinuationPrompt } from './continuation.js';

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
