import { PhaseSchema, type Phase } from '../../core/schemas/enums.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { createStore, storeBase } from '../create-store.js';

function phaseFromEvent(event: EngineEvent): Phase | undefined {
  const result = PhaseSchema.safeParse(event.phase);
  return result.success ? result.data : undefined;
}

const INFRASTRUCTURE_PHASE_EVENT_TYPES = new Set<EngineEvent['type']>([
  'ipc_client_attached',
  'ipc_client_detached',
  'ipc_reconnect_attempt',
  'ipc_reconnect_failed',
  'replay_started',
  'replay_complete',
]);

function isInfrastructurePhaseEvent(event: EngineEvent): boolean {
  return INFRASTRUCTURE_PHASE_EVENT_TYPES.has(event.type);
}

const STALL_CLEARING_EVENT_TYPES = new Set<EngineEvent['type']>([
  'runner_call_stall_cleared',
  'runner_call_activity',
  'runner_call_completed',
  'runner_call_error',
  'planner_text',
]);

type RunningPhase = Exclude<Phase, 'complete'>;
type LifecycleStatus = 'idle' | 'running' | 'interrupted' | 'complete' | 'cancelled';
type PhaseFirstSeenTs = Readonly<Partial<Record<Phase, number>>>;

type LifecycleStall = { since: number; silentMs: number } | null;

interface LifecycleBase {
  queueDepth: number;
  phaseFirstSeenTs: PhaseFirstSeenTs;
  stall: LifecycleStall;
}

interface IdleLifecycleState extends LifecycleBase {
  phase: 'idle';
  status: 'idle';
  interruptParked: false;
  cancelled: false;
  startedAt: null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

interface RunningLifecycleState extends LifecycleBase {
  phase: RunningPhase;
  status: 'running';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

// interruptParked distinguishes the dead-zone window (Esc-Esc landed but the
// continuation prompt has not reached a call boundary yet) from a parked prompt
// that actually owns the composer.
interface InterruptedLifecycleState extends LifecycleBase {
  phase: RunningPhase;
  status: 'interrupted';
  interruptParked: boolean;
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

interface CompleteLifecycleState extends LifecycleBase {
  phase: Phase;
  status: 'complete';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number;
  durationMs: number;
  reason: null;
}

interface CancelledLifecycleState extends LifecycleBase {
  phase: Phase;
  status: 'cancelled';
  interruptParked: false;
  cancelled: true;
  startedAt: number | null;
  endedAt: number;
  durationMs: number;
  reason: string;
}

export type LifecycleState =
  | IdleLifecycleState
  | RunningLifecycleState
  | InterruptedLifecycleState
  | CompleteLifecycleState
  | CancelledLifecycleState;

interface LifecycleResetState {
  phase?: Phase | undefined;
  status?: LifecycleStatus | undefined;
  cancelled?: boolean | undefined;
  queueDepth?: number | undefined;
  phaseFirstSeenTs?: PhaseFirstSeenTs | undefined;
  startedAt?: number | null | undefined;
  endedAt?: number | null | undefined;
  durationMs?: number | null | undefined;
  reason?: string | null | undefined;
}

const initial: LifecycleState = {
  phase: 'idle',
  status: 'idle',
  interruptParked: false,
  cancelled: false,
  queueDepth: 0,
  phaseFirstSeenTs: {},
  stall: null,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  reason: null,
};

const store = createStore<LifecycleState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: LifecycleResetState): void {
  store.set(next ? lifecycleStateFromReset(next) : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions.ts (the dispatcher).
export const _lifecycleInternal = { set: store.set };

export const lifecycleStore = {
  ...storeBase(store),
  __testReset,
};

export function updatePhase(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (isInfrastructurePhaseEvent(event)) return state;
  const phase = phaseFromEvent(event);

  if (event.type === 'workflow_started') {
    return runningLifecycleState({
      phase: phase ?? state.phase,
      queueDepth: state.queueDepth,
      phaseFirstSeenTs: phase === undefined ? {} : { [phase]: event.ts },
      startedAt: event.ts,
    });
  }

  if (event.type === 'workflow_resumed') {
    return runningLifecycleState({
      phase: phase ?? state.phase,
      queueDepth: state.queueDepth,
      phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, event.ts),
      startedAt: state.startedAt ?? event.ts,
    });
  }

  if (event.type === 'workflow_complete') {
    return markLifecycleComplete(state, event.ts, phase);
  }

  if (event.type === 'workflow_cancelled') {
    return markLifecycleCancellationRequested(
      state,
      {
        ts: event.ts,
        reason: event.reason ?? 'workflow_cancelled',
      },
      phase,
    );
  }

  // Attach clients have no markInterruptRequested keypress path — the bus event
  // is their only interrupt signal. The engine publishes it at the moment the
  // continuation prompt parks, so the park is marked here too; the host's
  // prompt-callbacks marks are idempotent re-marks.
  if (event.type === 'turn_interrupted') {
    return markLifecycleInterruptParked(
      markLifecycleInterrupted(applyRunningPhase(state, phase, event.ts)),
    );
  }

  // A spawning runner call is proof the work resumed: it clears an event-set
  // interrupt for attach viewers. It cannot fight a live host interrupt — no
  // call spawns while the turn is parked, and the host clears via
  // markInterruptResumed at the submit that triggers the resume.
  if (event.type === 'runner_call_started') {
    return applyRunningPhase(clearLifecycleInterrupted(state), phase, event.ts);
  }

  return applyRunningPhase(state, phase, event.ts);
}

export function updateQueueDepth(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type === 'message_queued') {
    return {
      ...state,
      queueDepth: state.queueDepth + 1,
    };
  }
  if (event.type === 'message_injected_native') {
    return {
      ...state,
      queueDepth: Math.max(0, state.queueDepth - 1),
    };
  }
  if (event.type === 'queue_drained') {
    if (state.queueDepth === 0) return state;
    const ids = event.ids === undefined ? null : new Set(event.ids);
    const drainedCount = ids?.size ?? event.count;
    const next = Math.max(0, state.queueDepth - drainedCount);
    return {
      ...state,
      queueDepth: next,
    };
  }
  if (event.type === 'queue_cleared') {
    const next = Math.max(0, state.queueDepth - event.count);
    if (next === state.queueDepth) return state;
    return {
      ...state,
      queueDepth: next,
    };
  }
  return state;
}

// Phase changes also clear stall, but that rule lives in applyRunningPhase:
// updatePhase runs before updateStall in the addEvent reducer chain, so by the
// time updateStall sees the state the phase transition has already cleared it.
export function updateStall(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type === 'runner_call_stalled') {
    return { ...state, stall: { since: event.ts, silentMs: event.silentMs } };
  }
  if (state.stall === null) return state;
  if (STALL_CLEARING_EVENT_TYPES.has(event.type)) {
    return { ...state, stall: null };
  }
  return state;
}

export function markLifecycleCancellationRequested(
  state: LifecycleState,
  cancellation: { ts: number; reason: string },
  phase?: Phase,
): LifecycleState {
  if (state.cancelled) return state;
  return {
    phase: phase ?? state.phase,
    status: 'cancelled',
    interruptParked: false,
    cancelled: true,
    queueDepth: state.queueDepth,
    phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, cancellation.ts),
    stall: null,
    startedAt: state.startedAt,
    endedAt: cancellation.ts,
    durationMs: durationFromStart(state.startedAt, cancellation.ts),
    reason: cancellation.reason,
  };
}

export function markLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'interrupted' };
}

export function markLifecycleInterruptParked(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted' || state.interruptParked) return state;
  return { ...state, interruptParked: true };
}

export function clearLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted') return state;
  return { ...state, status: 'running', interruptParked: false };
}

function markLifecycleComplete(
  state: LifecycleState,
  endedAt: number,
  phase?: Phase,
): LifecycleState {
  if (state.status === 'complete' && (phase === undefined || state.phase === phase)) return state;
  return {
    phase: phase ?? state.phase,
    status: 'complete',
    interruptParked: false,
    cancelled: false,
    queueDepth: state.queueDepth,
    phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, endedAt),
    stall: null,
    startedAt: state.startedAt,
    endedAt,
    durationMs: durationFromStart(state.startedAt, endedAt),
    reason: null,
  };
}

function durationFromStart(startedAt: number | null, endedAt: number): number {
  return Math.max(0, endedAt - (startedAt ?? endedAt));
}

// Allocates a new map only when a phase is first seen — footer selectors rely on the stable reference.
function withPhaseFirstSeen(
  firstSeen: PhaseFirstSeenTs,
  phase: Phase | undefined,
  ts: number,
): PhaseFirstSeenTs {
  if (phase === undefined || firstSeen[phase] !== undefined) return firstSeen;
  return { ...firstSeen, [phase]: ts };
}

function lifecycleStateFromReset(next: LifecycleResetState): LifecycleState {
  const phase = next.phase ?? initial.phase;
  const queueDepth = next.queueDepth ?? initial.queueDepth;
  const phaseFirstSeenTs = next.phaseFirstSeenTs ?? initial.phaseFirstSeenTs;
  const startedAt = next.startedAt ?? null;

  if (next.status === 'complete') {
    const endedAt = next.endedAt ?? startedAt ?? 0;
    return {
      phase,
      status: 'complete',
      interruptParked: false,
      cancelled: false,
      queueDepth,
      phaseFirstSeenTs,
      stall: null,
      startedAt,
      endedAt,
      durationMs: next.durationMs ?? durationFromStart(startedAt, endedAt),
      reason: null,
    };
  }

  if (next.cancelled || next.status === 'cancelled') {
    const endedAt = next.endedAt ?? startedAt ?? 0;
    return {
      phase,
      status: 'cancelled',
      interruptParked: false,
      cancelled: true,
      queueDepth,
      phaseFirstSeenTs,
      stall: null,
      startedAt,
      endedAt,
      durationMs: next.durationMs ?? durationFromStart(startedAt, endedAt),
      reason: next.reason ?? 'user_cancelled',
    };
  }

  if (next.status === 'interrupted') {
    return markLifecycleInterrupted(
      runningLifecycleState({ phase, queueDepth, phaseFirstSeenTs, startedAt }),
    );
  }

  if (next.status === 'running' || phase !== 'idle') {
    return runningLifecycleState({ phase, queueDepth, phaseFirstSeenTs, startedAt });
  }

  return {
    ...initial,
    queueDepth,
    phaseFirstSeenTs,
  };
}

function applyRunningPhase(
  state: LifecycleState,
  phase: Phase | undefined,
  ts: number,
): LifecycleState {
  if (phase === undefined || state.phase === phase) return state;
  const phaseFirstSeenTs = withPhaseFirstSeen(state.phaseFirstSeenTs, phase, ts);
  if (state.status === 'idle') {
    return runningLifecycleState({
      phase,
      queueDepth: state.queueDepth,
      phaseFirstSeenTs,
      startedAt: ts,
    });
  }
  if (state.status === 'running' || state.status === 'interrupted') {
    return { ...state, phase: runningPhase(phase), phaseFirstSeenTs, stall: null };
  }
  return { ...state, phase, phaseFirstSeenTs };
}

function runningLifecycleState(input: {
  phase: Phase;
  queueDepth: number;
  phaseFirstSeenTs: PhaseFirstSeenTs;
  startedAt: number | null;
}): RunningLifecycleState {
  return {
    phase: runningPhase(input.phase),
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: input.queueDepth,
    phaseFirstSeenTs: input.phaseFirstSeenTs,
    stall: null,
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
}

function runningPhase(phase: Phase): RunningPhase {
  return phase === 'complete' ? 'idle' : phase;
}
