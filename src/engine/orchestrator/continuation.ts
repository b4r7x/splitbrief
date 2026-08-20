import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from './state-ops.js';
import { processError } from '../../lib/process/errors.js';
import { throwIfAborted } from '../../utils/abort.js';
import { error } from '../../utils/error.js';

export function buildContinuationPrompt(partialResponse: string, userMessage: string): string {
  const instruction = userMessage.trim() || 'Please continue from where you left off.';
  return `The previous attempt was interrupted. Here is the partial response:\n\n${partialResponse}\n\n${instruction}`;
}

interface ContinuationLoopBaseCtx {
  projectDir: string;
  sessionId: string;
  /** When execution cwd differs from the real session tree, persist transitions here. */
  persistRef?: { projectDir: string; sessionId: string } | undefined;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  signal?: AbortSignal | undefined;
  sinks: WorkflowSinks;
}

export type RecoveryContinuationMarker = {
  briefRecovery: true;
  operationId: string;
  noAutomaticContinuation: true;
};

type OrdinaryContinuationLoopCtx = ContinuationLoopBaseCtx & {
  briefRecovery?: false | undefined;
  operationId?: undefined;
  noAutomaticContinuation?: false | undefined;
};

export type ContinuationLoopCtx =
  | OrdinaryContinuationLoopCtx
  | (ContinuationLoopBaseCtx & RecoveryContinuationMarker);

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
  const recoveryContinuation = ctx.briefRecovery === true;
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
      if (recoveryContinuation) {
        throw error(
          'continuation-recovery-operation-invalid',
          `Recovery operation ${ctx.operationId} requires a new operation.`,
        );
      }
      if (!callbacks.onContinuationNeeded) continue;
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      steer = userText.trim() === '' ? undefined : userText;
    }
    const callController = new AbortController();
    sinks.setAbortHandler(() => callController.abort());
    partialOutput = '';

    const bodySignal = ctx.signal
      ? AbortSignal.any([ctx.signal, callController.signal])
      : callController.signal;

    let attempt: T;
    try {
      attempt = await body({ signal: bodySignal, continuationPrompt, steer, recordOutput });
    } catch (err) {
      sinks.setAbortHandler(null);

      if (recoveryContinuation) throw err;

      if (
        (callController.signal.aborted || processError.isIdleTimeout(err)) &&
        !ctx.signal?.aborted &&
        callbacks.onContinuationNeeded
      ) {
        const userText = await continueAfterAbort(
          callbacks.onContinuationNeeded,
          callController.signal.aborted ? 'user' : 'watchdog',
        );
        continuationPrompt = buildContinuationPrompt(partialOutput, userText);
        steer = undefined;
        continue;
      }

      throw err;
    }

    sinks.setAbortHandler(null);

    if (
      callController.signal.aborted &&
      !ctx.signal?.aborted &&
      !recoveryContinuation &&
      callbacks.onContinuationNeeded
    ) {
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      continuationPrompt = buildContinuationPrompt(partialOutput, userText);
      steer = undefined;
      continue;
    }

    return { state, value: attempt };
  }
}
