import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import { withPerCallAbort } from './cancellable-call.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from './state-ops.js';
import { appendMessage } from '../../core/sessions/log-writer.js';
import { publishUserMessage } from './events.js';
import { readMessages } from '../../core/sessions/log-reader.js';
import { processError } from '../../lib/process/errors.js';
import { throwIfAborted } from '../../utils/abort.js';

/**
 * The partial a killed process left behind. The transcript buffer flushes it
 * marked `interrupted`, so the last such message is the cut attempt's output —
 * no index to carry across the restart.
 */
export async function readInterruptedPartial(ref: SessionRef): Promise<string | undefined> {
  let latest: string | undefined;
  try {
    for await (const message of readMessages(ref)) {
      if (message.interrupted === true) latest = message.text;
    }
  } catch {
    return undefined;
  }
  return latest === undefined || latest.trim() === '' ? undefined : latest;
}

export type ContinuationSeed = {
  partial?: string | undefined;
  steer?: string | undefined;
};

export type ContinuationHolder = {
  /** The seed for this step, when the run was continued at it. Consumed once. */
  take: (step: StepRef) => ContinuationSeed | undefined;
  /** Holds a steer for the step the run is about to start. */
  hold: (step: StepRef, steer: string | undefined) => void;
};

/** Two steps are the same work; the attempt or cycle number is which try it is. */
function sameStep(a: StepRef, b: StepRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'planner') return b.kind === 'planner' && a.call === b.call;
  if (a.kind === 'gate') return b.kind === 'gate' && a.gate === b.gate;
  if (a.kind === 'brief') return b.kind === 'brief' && a.taskId === b.taskId;
  return true;
}

/**
 * The continuation a run carries between steps: what a killed attempt left
 * behind and what the operator said to restart it. One step owns it — the one
 * the run stopped at — so a later step never inherits another step's partial.
 */
export function createContinuationHolder(
  initial?: (ContinuationSeed & { step: StepRef }) | undefined,
): ContinuationHolder {
  let pending = initial;
  return {
    take(step) {
      if (pending === undefined || !sameStep(pending.step, step)) return undefined;
      const { partial, steer } = pending;
      pending = undefined;
      if (partial === undefined && steer === undefined) return undefined;
      return {
        ...(partial !== undefined && { partial }),
        ...(steer !== undefined && { steer }),
      };
    },
    hold(step, steer) {
      pending = steer === undefined ? undefined : { step, steer };
    },
  };
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
  /** Output the interrupted attempt produced; absent on a first, uninterrupted attempt. */
  partial: string | undefined;
  /** What the operator typed when they resumed. */
  steer: string | undefined;
  recordOutput: (text: string) => void;
}

export interface WithContinuationLoopOpts<T> {
  ctx: ContinuationLoopCtx;
  state: WorkflowState;
  /** The step this loop is running, recorded on the state while the call is parked. */
  step: StepRef;
  /**
   * A continuation this loop inherits rather than produces: the partial a killed
   * process left on disk and the steer that restarted the run. Consumed by the
   * first attempt only.
   */
  seed?: { partial?: string | undefined; steer?: string | undefined } | undefined;
  onStateChange?: ((s: WorkflowState) => void) | undefined;
  body: (args: ContinuationLoopBodyArgs) => Promise<T>;
}

/**
 * The words the operator sent into a cut call are the user turn they are:
 * recorded once in the transcript and the session log. They still travel on as
 * the steer the retried call composes into its own prompt.
 */
function recordSteer(
  ctx: ContinuationLoopCtx,
  phase: WorkflowState['phase'],
  text: string | undefined,
): void {
  if (text === undefined || text.trim() === '') return;
  appendMessage(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    { role: 'user', phase, text },
  );
  publishUserMessage({ bus: ctx.bus, phase }, text);
}

export async function withContinuationLoop<T>(
  opts: WithContinuationLoopOpts<T>,
): Promise<{ state: WorkflowState; value: T }> {
  const { ctx, step, onStateChange, body } = opts;
  const { projectDir, sessionId, callbacks, sinks, bus } = ctx;
  const persistRef = ctx.persistRef ?? { projectDir, sessionId };
  let state = opts.state;
  let partial = opts.seed?.partial;
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
  ): Promise<string> => {
    const current = rebaseOnPersistedWorkflowState(persistRef, state);
    applyState(
      transitionAndSave(persistRef, current, {
        type: 'INTERRUPT_STEP',
        step,
        source,
        cut: 'mid-step',
      }),
    );
    bus.publish({
      type: 'turn_interrupted',
      ts: Date.now(),
      phase: state.phase,
      source,
      at: 'mid-step',
    });
    const userText = await onContinuationNeeded(partialOutput, 'mid-step');
    throwIfAborted(ctx.signal);
    applyState(transitionAndSave(persistRef, state, { type: 'RESUME_STEP' }));
    recordSteer(ctx, state.phase, userText);
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
          return body({ signal, partial, steer, recordOutput });
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
        steer = userText.trim() === '' ? undefined : userText;
        continue;
      }

      throw err;
    }

    if (interruptedThisCall() && callbacks.onContinuationNeeded) {
      const userText = await continueAfterAbort(callbacks.onContinuationNeeded, 'user');
      partial = partialOutput;
      steer = userText.trim() === '' ? undefined : userText;
      continue;
    }

    return { state, value: attempt };
  }
}
