import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import { withPerCallAbort } from './cancellable-call.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from './state-ops.js';
import { processError } from '../../lib/process/errors.js';
import { throwIfAborted } from '../../utils/abort.js';

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
  bus: EventBus;
  signal?: AbortSignal | undefined;
  sinks: WorkflowSinks;
}

export interface ContinuationLoopBodyArgs {
  signal: AbortSignal;
  continuationPrompt: string | undefined;
  /** Steer text from a parked boundary interrupt; bodies prefix it to their primary prompt via composeSteeredPrompt. */
  steer: string | undefined;
  recordOutput: (text: string) => void;
}

export interface WithContinuationLoopOpts<T> {
  ctx: ContinuationLoopCtx;
  state: WorkflowState;
  onStateChange?: ((s: WorkflowState) => void) | undefined;
  body: (args: ContinuationLoopBodyArgs) => Promise<T>;
}

export async function withContinuationLoop<T>(
  opts: WithContinuationLoopOpts<T>,
): Promise<{ state: WorkflowState; value: T }> {
  const { ctx, onStateChange, body } = opts;
  const { projectDir, sessionId, callbacks, sinks, bus } = ctx;
  const persistRef = ctx.persistRef ?? { projectDir, sessionId };
  let state = opts.state;
  let continuationPrompt: string | undefined;
  let steer: string | undefined;
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
    source: 'user' | 'watchdog',
  ): Promise<string> => {
    const current = rebaseOnPersistedWorkflowState(persistRef, state);
    applyState(transitionAndSave(persistRef, current, { type: 'ABORT_TURN' }));
    bus.publish({ type: 'turn_interrupted', ts: Date.now(), phase: state.phase, source });
    const userText = await onContinuationNeeded(partialOutput);
    throwIfAborted(ctx.signal);
    applyState(transitionAndSave(persistRef, state, { type: 'CONTINUE_TURN' }));
    return userText;
  };

  while (true) {
    if (sinks.consumeBoundaryInterrupt?.()) {
      if (!callbacks.onContinuationNeeded) continue;
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      steer = userText.trim() === '' ? undefined : userText;
    }
    partialOutput = '';

    let bodySignal: AbortSignal | undefined;
    const interruptedThisCall = () => bodySignal?.aborted === true && ctx.signal?.aborted !== true;

    let attempt: T;
    try {
      attempt = await withPerCallAbort({
        sinks,
        signal: ctx.signal,
        run: (signal) => {
          bodySignal = signal;
          return body({ signal, continuationPrompt, steer, recordOutput });
        },
      });
    } catch (err) {
      if (
        (interruptedThisCall() || processError.isIdleTimeout(err)) &&
        !ctx.signal?.aborted &&
        callbacks.onContinuationNeeded
      ) {
        const userText = await continueAfterAbort(
          callbacks.onContinuationNeeded,
          interruptedThisCall() ? 'user' : 'watchdog',
        );
        continuationPrompt = buildContinuationPrompt(partialOutput, userText);
        steer = undefined;
        continue;
      }

      throw err;
    }

    if (interruptedThisCall() && callbacks.onContinuationNeeded) {
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      continuationPrompt = buildContinuationPrompt(partialOutput, userText);
      steer = undefined;
      continue;
    }

    return { state, value: attempt };
  }
}
