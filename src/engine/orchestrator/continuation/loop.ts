import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { processError } from '../../../lib/process/errors.js';
import { throwIfAborted } from '../../../utils/abort.js';
import type { EventBus } from '../../events/types.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { keptBriefFiles } from '../kept-work.js';
import { formatMessageInput } from '../queue/prompt.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { recordUserMessage } from '../transcript/user-message.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { ContinuationSeed } from './holder.js';

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
  /** Output the interrupted attempt produced; absent on a first, uninterrupted attempt. */
  partial: string | undefined;
  /** What the operator typed when they resumed. */
  steer: string | undefined;
  steerInput: UserMessageInput | undefined;
  recordOutput: (text: string) => void;
}

export interface WithContinuationLoopOpts<T> {
  ctx: ContinuationLoopCtx;
  state: WorkflowState;
  /** The step this loop is running, recorded on the state while the call is parked. */
  step: StepRef;
  /**
   * A continuation this loop inherits rather than produces: the partial a killed
   * process left on disk, the steer that restarted the run, and whether a cut brief
   * continues in its kept workspace. Consumed by the first attempt only.
   */
  seed?: ContinuationSeed | undefined;
  onStateChange?: ((s: WorkflowState) => void) | undefined;
  body: (args: ContinuationLoopBodyArgs) => Promise<T>;
}

/**
 * The words the operator sent into a cut call are the user turn they are:
 * recorded once in the transcript and the session log. They still travel on as
 * the steer the retried call composes into its own prompt.
 */
export function recordSteer(
  ctx: Pick<ContinuationLoopCtx, 'projectDir' | 'sessionId' | 'persistRef' | 'bus'>,
  phase: WorkflowState['phase'],
  message: UserMessageInput | undefined,
): void {
  if (message === undefined || message.text.trim() === '') return;
  recordUserMessage({ ...(ctx.persistRef ?? ctx), bus: ctx.bus, phase }, message);
}

export async function withContinuationLoop<T>(
  opts: WithContinuationLoopOpts<T>,
): Promise<{ state: WorkflowState; value: T }> {
  const { ctx, step, onStateChange, body } = opts;
  const { projectDir, sessionId, callbacks, sinks, bus } = ctx;
  const persistRef = ctx.persistRef ?? { projectDir, sessionId };
  let state = opts.state;
  // A kept workspace names a cut attempt even when it printed nothing, with or without a steer.
  let partial = opts.seed?.partial ?? (opts.seed?.keepWorkspace === true ? '' : undefined);
  let steer = opts.seed?.steer;
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
  ): Promise<UserMessageInput> => {
    const current = rebaseOnPersistedWorkflowState(persistRef, state);
    // The cut call's own workspace: what a brief left there is what the stop keeps.
    const kept = await keptBriefFiles(projectDir, current, step);
    applyState(
      transitionAndSave(persistRef, current, {
        type: 'INTERRUPT_STEP',
        step,
        source,
        cut: 'mid-step',
        kept,
      }),
    );
    bus.publish({
      type: 'turn_interrupted',
      ts: Date.now(),
      phase: state.phase,
      source,
      at: 'mid-step',
      step,
      ...(kept.length > 0 && { kept: [...kept] }),
    });
    const userText = await onContinuationNeeded(partialOutput, 'mid-step', kept);
    throwIfAborted(ctx.signal);
    applyState(transitionAndSave(persistRef, state, { type: 'CONTINUE_STEP' }));
    recordSteer(ctx, state.phase, userText);
    applyState(rebaseOnPersistedWorkflowState(persistRef, state));
    return userText;
  };

  while (true) {
    if (sinks.consumeBoundaryInterrupt?.()) {
      if (!callbacks.onContinuationNeeded) continue;
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      steer = userText.text.trim() === '' ? undefined : userText;
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
          return body({
            signal,
            partial,
            steer: steer === undefined ? undefined : formatMessageInput(steer),
            steerInput: steer,
            recordOutput,
          });
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
        partial = partialOutput;
        steer = userText.text.trim() === '' ? undefined : userText;
        continue;
      }

      throw err;
    }

    if (interruptedThisCall() && callbacks.onContinuationNeeded) {
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      partial = partialOutput;
      steer = userText.text.trim() === '' ? undefined : userText;
      continue;
    }

    return { state, value: attempt };
  }
}
