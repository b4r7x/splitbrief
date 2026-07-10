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

type RunningPhase = Exclude<Phase, 'complete'>;
type LifecycleStatus = 'idle' | 'running' | 'complete' | 'cancelled';
type PhaseFirstSeenTs = Readonly<Partial<Record<Phase, number>>>;

interface LifecycleBase {
  queueDepth: number;
  phaseFirstSeenTs: PhaseFirstSeenTs;
}

interface IdleLifecycleState extends LifecycleBase {
  phase: 'idle';
  status: 'idle';
  cancelled: false;
  startedAt: null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

interface RunningLifecycleState extends LifecycleBase {
  phase: RunningPhase;
  status: 'running';
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

interface CompleteLifecycleState extends LifecycleBase {
  phase: Phase;
  status: 'complete';
  cancelled: false;
  startedAt: number | null;
  endedAt: number;
  durationMs: number;
  reason: null;
}

interface CancelledLifecycleState extends LifecycleBase {
  phase: Phase;
  status: 'cancelled';
  cancelled: true;
  startedAt: number | null;
  endedAt: number;
  durationMs: number;
  reason: string;
}

export type LifecycleState =
  | IdleLifecycleState
  | RunningLifecycleState
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
  cancelled: false,
  queueDepth: 0,
  phaseFirstSeenTs: {},
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

export function markLifecycleCancellationRequested(
  state: LifecycleState,
  cancellation: { ts: number; reason: string },
  phase?: Phase,
): LifecycleState {
  if (state.cancelled) return state;
  return {
    phase: phase ?? state.phase,
    status: 'cancelled',
    cancelled: true,
    queueDepth: state.queueDepth,
    phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, cancellation.ts),
    startedAt: state.startedAt,
    endedAt: cancellation.ts,
    durationMs: durationFromStart(state.startedAt, cancellation.ts),
    reason: cancellation.reason,
  };
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
    cancelled: false,
    queueDepth: state.queueDepth,
    phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, endedAt),
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
      cancelled: false,
      queueDepth,
      phaseFirstSeenTs,
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
      cancelled: true,
      queueDepth,
      phaseFirstSeenTs,
      startedAt,
      endedAt,
      durationMs: next.durationMs ?? durationFromStart(startedAt, endedAt),
      reason: next.reason ?? 'user_cancelled',
    };
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
  if (state.status === 'running') {
    return { ...state, phase: runningPhase(phase), phaseFirstSeenTs };
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
    cancelled: false,
    queueDepth: input.queueDepth,
    phaseFirstSeenTs: input.phaseFirstSeenTs,
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
}

function runningPhase(phase: Phase): RunningPhase {
  return phase === 'complete' ? 'idle' : phase;
}
