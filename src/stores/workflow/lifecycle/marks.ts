import type { Phase } from '../../../core/schemas/enums.js';
import type { LifecycleState } from './types.js';

export function markLifecycleCancellationRequested(
  state: LifecycleState,
  cancellation: { ts: number; reason: string },
): LifecycleState {
  if (state.cancelled) return state;
  return {
    status: 'cancelled',
    interruptParked: false,
    cancelled: true,
    queueDepth: state.queueDepth,
    queuedMessageIds: state.queuedMessageIds,
    steerableCall: null,
    stall: null,
    retry: null,
    startedAt: state.startedAt,
    endedAt: cancellation.ts,
    durationMs: state.durationMs ?? durationFromStart(state.startedAt, cancellation.ts),
    reason: cancellation.reason,
  };
}

export function markLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'interrupted', retry: null };
}

export function markLifecyclePaused(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'running' && state.status !== 'interrupted') return state;
  return {
    ...state,
    status: 'paused',
    interruptParked: false,
    stall: null,
    retry: null,
    durationMs: state.durationMs ?? durationFromStart(state.startedAt, ts),
  };
}

// A wait is the byline clock stopping on the user: a question, a review gate, an approval. One wait
// is open at a time, and a prompt that supersedes another keeps the same wait open.
export function markLifecycleWaitStarted(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'running' || (state.waitingSince ?? null) !== null) return state;
  return { ...state, waitingSince: ts };
}

/** The wait counts against `phase`, the phase the run view says the run waited in. */
export function markLifecycleWaitEnded(
  state: LifecycleState,
  ts: number,
  phase: Phase,
): LifecycleState {
  const since = state.waitingSince ?? null;
  if (since === null) return state;
  const waited = (state.waitedMs?.[phase] ?? 0) + Math.max(0, ts - since);
  return { ...state, waitingSince: null, waitedMs: { ...state.waitedMs, [phase]: waited } };
}

export function markLifecycleInterruptParked(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted' || state.interruptParked) return state;
  return { ...state, interruptParked: true };
}

export function clearLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted') return state;
  return state.durationMs === null
    ? { ...state, status: 'running', interruptParked: false, durationMs: null }
    : { ...state, status: 'paused', interruptParked: false };
}

// A parked run has no event of its own to un-park it: the next call spawning is the proof that the
// steer landed and the work carried on.
export function clearLifecyclePaused(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'paused') return state;
  // A run that is moving again has no end and no duration. Its stage clock starts again here, so
  // the waits it already subtracted go with it.
  return {
    ...state,
    status: 'running',
    endedAt: null,
    durationMs: null,
    resumedAt: ts,
    waitedMs: {},
  };
}

export function markLifecycleComplete(state: LifecycleState, endedAt: number): LifecycleState {
  if (state.status === 'complete') return state;
  return {
    status: 'complete',
    interruptParked: false,
    cancelled: false,
    queueDepth: state.queueDepth,
    queuedMessageIds: state.queuedMessageIds,
    steerableCall: null,
    stall: null,
    retry: null,
    startedAt: state.startedAt,
    endedAt,
    durationMs: state.durationMs ?? durationFromStart(state.startedAt, endedAt),
    reason: null,
  };
}

export function durationFromStart(startedAt: number | null, endedAt: number): number {
  return Math.max(0, endedAt - (startedAt ?? endedAt));
}
