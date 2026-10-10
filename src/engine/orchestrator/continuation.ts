import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import type { OrchestratorCallbacks, WorkflowSinks } from './types.js';
import type { EventBus } from '../events/types.js';
import { withPerCallAbort } from './cancellable-call.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from './state-ops.js';
import { recordUserMessage } from './transcript/user-message.js';
import { readSessionLog } from '../../core/sessions/log-reader.js';
import { engineEventFromLogEntry } from '../events/replay.js';
import { processError } from '../../lib/process/errors.js';
import { throwIfAborted } from '../../utils/abort.js';
import { PARTIAL_MAX_CHARS } from '../spec/prompts/continuation.js';
import { formatMessageInput } from './queue/prompt.js';

/**
 * The cut call's assistant stream, bounded to the continuation prompt's
 * existing limit. A final interrupted marker identifies that call even when
 * the buffer already flushed its last text chunk or the call printed nothing.
 * A later call start clears every earlier candidate.
 */
export async function readInterruptedPartial(ref: SessionRef): Promise<string | undefined> {
  let latest: string | undefined;
  let tail = '';
  let truncated = false;
  try {
    for await (const entry of readSessionLog(ref)) {
      if (entry.kind === 'event' && entry.type === 'runner_call_started') {
        latest = undefined;
        tail = '';
        truncated = false;
      }
      if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
      tail += entry.text;
      if (tail.length > PARTIAL_MAX_CHARS) {
        tail = tail.slice(1 - PARTIAL_MAX_CHARS);
        truncated = true;
      }
      if (entry.interrupted === true) {
        latest = truncated ? `…${tail}` : tail;
        tail = '';
        truncated = false;
      }
    }
  } catch {
    return undefined;
  }
  return latest;
}

/**
 * The brief a stop cut mid-step that has not run again. The latest `turn_interrupted` names it until
 * a later call starts, a later stop replaces it, the operator redoes that brief (`task_reset`), or
 * the operator resolves a halt by anything but continuing (retry, skip, end): the rule
 * `readInterruptedPartial` applies to the partial.
 */
export async function readUnresumedBriefCut(ref: SessionRef): Promise<
  | {
      step: Extract<StepRef, { kind: 'brief' }>;
      source: 'user' | 'watchdog';
      at: string;
    }
  | undefined
> {
  let cut: Awaited<ReturnType<typeof readUnresumedBriefCut>>;
  for await (const entry of readSessionLog(ref)) {
    if (entry.kind !== 'event') continue;
    if (entry.type === 'runner_call_started') {
      cut = undefined;
      continue;
    }
    if (
      entry.type !== 'turn_interrupted' &&
      entry.type !== 'recovery_resolved' &&
      entry.type !== 'task_reset'
    )
      continue;
    const event = engineEventFromLogEntry(entry);
    if (event?.type === 'task_reset') {
      if (event.taskId === cut?.step.taskId) cut = undefined;
    } else if (event?.type === 'recovery_resolved') {
      if (event.outcome !== 'continued') cut = undefined;
    } else if (event?.type === 'turn_interrupted') {
      cut =
        event.at === 'mid-step' && event.step?.kind === 'brief'
          ? {
              step: event.step,
              source: event.source ?? 'user',
              at: new Date(event.ts).toISOString(),
            }
          : undefined;
    }
  }
  return cut;
}

export type ContinuationSeed = {
  partial?: string | undefined;
  steer?: UserMessageInput | undefined;
  keepWorkspace?: true | undefined;
};

export type ContinuationHolder = {
  /** The seed for this step, when the run was continued at it. Consumed once. */
  take: (step: StepRef, briefFingerprint?: string) => ContinuationSeed | undefined;
  /** Holds a steer for the step the run is about to start. */
  hold: (step: StepRef, steer: UserMessageInput | undefined) => void;
  /**
   * The step continues its cut attempt in the kept workspace. Its brief was refreshed when that
   * attempt was dispatched; the workspace now also holds the attempt's own output.
   */
  resumesAttempt: (step: StepRef, briefFingerprint: string) => boolean;
};

/**
 * Two step refs name the same parked work. A brief also compares its attempt: a
 * mid-step partial belongs to the try that produced it, so a seed an earlier
 * attempt left must not resume a later one — a reset attempt starts clean. A run plans in one
 * session, so every planner step is that session, whichever retired call an old run saved.
 */
function sameStep(a: StepRef, b: StepRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'planner') return true;
  if (a.kind === 'gate') return b.kind === 'gate' && a.gate === b.gate;
  if (a.kind === 'brief')
    return b.kind === 'brief' && a.taskId === b.taskId && a.attempt === b.attempt;
  if (a.kind === 'apply') return true;
  return b.kind === 'review' && a.cycle === b.cycle;
}

/**
 * The continuation a run carries between steps: what a killed attempt left
 * behind and what the operator said to restart it. One step owns it — the one
 * the run stopped at — so a later step never inherits another step's partial.
 */
export function createContinuationHolder(
  initial?: (ContinuationSeed & { step: StepRef; briefFingerprint?: string }) | undefined,
): ContinuationHolder {
  let pending = initial;
  return {
    take(step, briefFingerprint) {
      if (pending === undefined || !sameStep(pending.step, step)) return undefined;
      if (pending.briefFingerprint !== undefined && pending.briefFingerprint !== briefFingerprint) {
        pending = undefined;
        return undefined;
      }
      const { partial, steer, keepWorkspace } = pending;
      pending = undefined;
      if (partial === undefined && steer === undefined && keepWorkspace !== true) return undefined;
      return {
        ...(partial !== undefined && { partial }),
        ...(steer !== undefined && { steer }),
        ...(keepWorkspace === true && { keepWorkspace }),
      };
    },
    hold(step, steer) {
      pending = steer === undefined ? undefined : { step, steer };
    },
    resumesAttempt(step, briefFingerprint) {
      return (
        pending?.keepWorkspace === true &&
        sameStep(pending.step, step) &&
        pending.briefFingerprint === briefFingerprint
      );
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
   * process left on disk and the steer that restarted the run. Consumed by the
   * first attempt only.
   */
  seed?: { partial?: string | undefined; steer?: UserMessageInput | undefined } | undefined;
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
  // An explicit empty seed names a cut attempt even when it produced no text.
  let partial =
    opts.seed?.partial ??
    (opts.seed !== undefined && opts.seed.steer === undefined ? '' : undefined);
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
      step,
    });
    const userText = await onContinuationNeeded(partialOutput, 'mid-step');
    throwIfAborted(ctx.signal);
    applyState(transitionAndSave(persistRef, state, { type: 'RESUME_STEP' }));
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
