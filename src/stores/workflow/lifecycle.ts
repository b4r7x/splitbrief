import type { CrewSeatId } from '../../core/crew/identity.js';
import type { Phase, RunnerKind } from '../../core/schemas/enums.js';
import type { PlannerCall } from '../../core/schemas/run-step.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { createStore, storeBase } from '../create-store.js';

const STALL_CLEARING_EVENT_TYPES = new Set<EngineEvent['type']>([
  'runner_call_stall_cleared',
  'runner_call_activity',
  'runner_call_completed',
  'runner_call_error',
  'planner_text',
]);

type LifecycleStatus = 'idle' | 'running' | 'interrupted' | 'paused' | 'complete' | 'cancelled';

type LifecycleStall = {
  since: number;
  silentMs: number;
  runnerName: string | null;
  /** The backend kind of the stalled call; absent on records written before kinds. */
  backendKind?: RunnerKind | undefined;
} | null;

interface LifecycleBase {
  queueDepth: number;
  queuedMessageIds: ReadonlySet<string>;
  steerableCall: { seat: CrewSeatId; taskId?: string } | null;
  stall: LifecycleStall;
  /** When the run last produced any sign of life, so a silent seat can be named as silent. */
  lastRunnerEventTs?: number | null;
  /** When the attempt now running began, so its elapsed time is not the whole brief's. */
  attemptStartedTs?: number | null;
  /** The planner call the phase is on, when the engine named one: a phase can hold two. */
  plannerCall?: PlannerCall | null;
  /**
   * Where the byline clock of that call starts: the moment it opened, or, for the first call since
   * the run started or resumed, that start — the preparation before it was the call's too.
   */
  plannerCallStartedTs?: number | null;
  /** When the run started waiting on the user, so that time stays out of the stage clock. */
  waitingSince?: number | null;
  /** Time already spent waiting on the user, by the phase it was spent in. */
  waitedMs?: Readonly<Partial<Record<Phase, number>>>;
  /** When a stopped run last started moving again, so the stage clock leaves its park out. */
  resumedAt?: number | null;
  /**
   * The lifecycle is the saved state read back from disk, and the engine has not started, resumed,
   * completed or cancelled the run since.
   */
  restored?: boolean;
}

interface IdleLifecycleState extends LifecycleBase {
  status: 'idle';
  interruptParked: false;
  cancelled: false;
  startedAt: null;
  endedAt: null;
  durationMs: null;
  reason: null;
}

interface RunningLifecycleState extends LifecycleBase {
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
  status: 'interrupted';
  interruptParked: boolean;
  cancelled: false;
  startedAt: number | null;
  endedAt: null;
  durationMs: number | null;
  reason: null;
}

interface PausedLifecycleState extends LifecycleBase {
  status: 'paused';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  reason: null;
}

interface CompleteLifecycleState extends LifecycleBase {
  status: 'complete';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  reason: null;
}

interface CancelledLifecycleState extends LifecycleBase {
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
  | PausedLifecycleState
  | CompleteLifecycleState
  | CancelledLifecycleState;

interface LifecycleResetState {
  status?: LifecycleStatus | undefined;
  cancelled?: boolean | undefined;
  queueDepth?: number | undefined;
  startedAt?: number | null | undefined;
  endedAt?: number | null | undefined;
  durationMs?: number | null | undefined;
  reason?: string | null | undefined;
}

const initial: LifecycleState = {
  status: 'idle',
  interruptParked: false,
  cancelled: false,
  queueDepth: 0,
  queuedMessageIds: new Set(),
  steerableCall: null,
  stall: null,
  lastRunnerEventTs: null,
  attemptStartedTs: null,
  plannerCall: null,
  plannerCallStartedTs: null,
  waitingSince: null,
  waitedMs: {},
  resumedAt: null,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  reason: null,
};

const store = createStore<LifecycleState>(initial);

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: LifecycleResetState): void {
  store.set(next ? lifecycleStateFromReset(next) : initial);
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions/ (the dispatcher).
export const _lifecycleInternal = { set: store.set };

export const lifecycleStore = {
  ...storeBase(store),
  __testReset,
};

const RUNNER_HEARTBEAT_EVENT_TYPES = new Set<EngineEvent['type']>([
  'runner_call_started',
  'runner_call_heartbeat',
  'runner_call_activity',
  'runner_call_usage',
  'runner_call_warning',
  'runner_call_completed',
  'runner_call_error',
  'planner_text',
  'implementer_generate_running',
  'implementer_generate_done',
  'implementer_generate_failed',
  'full_suite',
  'checks_run',
  'validate',
  'review_checks',
  'review_started',
  'review_step',
  'review_completed',
]);

/** The two clocks the build-progress block reads: last sign of life, and this attempt's start. */
function updateRunClocks(state: LifecycleState, event: EngineEvent): LifecycleState {
  const lastRunnerEventTs = RUNNER_HEARTBEAT_EVENT_TYPES.has(event.type)
    ? event.ts
    : (state.lastRunnerEventTs ?? null);
  const attemptStartedTs =
    event.type === 'task_started' || event.type === 'task_retry'
      ? event.ts
      : (state.attemptStartedTs ?? null);
  if (
    lastRunnerEventTs === state.lastRunnerEventTs &&
    attemptStartedTs === state.attemptStartedTs
  ) {
    return state;
  }
  return { ...state, lastRunnerEventTs, attemptStartedTs };
}

// The status event is the whole truth about the call: a running status names the call it opens,
// and one that names none — a gate, a side call, a done — means no document call is running.
function updatePlannerCall(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type !== 'planner_status') return state;
  const plannerCall = event.status === 'running' ? (event.call ?? null) : null;
  if (plannerCall === (state.plannerCall ?? null)) return state;
  if (plannerCall === null) return { ...state, plannerCall };
  if ((state.plannerCallStartedTs ?? null) === null) {
    return {
      ...state,
      plannerCall,
      plannerCallStartedTs: state.resumedAt ?? state.startedAt ?? event.ts,
    };
  }
  // A call that follows another starts the byline clock again, and the waits the stage spent
  // before it go with the call they were spent in.
  return { ...state, plannerCall, plannerCallStartedTs: event.ts, waitedMs: {} };
}

/** `phaseChanged` is the run view's own fold of the same event: the view owns the phase. */
export function updatePhase(
  state: LifecycleState,
  event: EngineEvent,
  phaseChanged: boolean,
): LifecycleState {
  if (event.type === 'steerable_call') {
    const steerableCall =
      event.seat === undefined
        ? null
        : { seat: event.seat, ...(event.taskId !== undefined && { taskId: event.taskId }) };
    return { ...state, steerableCall };
  }
  return updatePlannerCall(
    updatePhaseOnly(updateRunClocks(state, event), event, phaseChanged),
    event,
  );
}

function updatePhaseOnly(
  state: LifecycleState,
  event: EngineEvent,
  phaseChanged: boolean,
): LifecycleState {
  if (event.type === 'workflow_started') {
    return runningLifecycleState({
      queuedMessageIds: state.queuedMessageIds,
      startedAt: event.ts,
    });
  }

  if (event.type === 'workflow_resumed') {
    return runningLifecycleState({
      queuedMessageIds: state.queuedMessageIds,
      startedAt: state.startedAt ?? event.ts,
      resumedAt: event.resumedAt ?? event.ts,
    });
  }

  if (event.type === 'workflow_complete') {
    return markLifecycleComplete(state, event.ts);
  }

  if (event.type === 'workflow_cancelled') {
    return markLifecycleCancellationRequested(state, {
      ts: event.ts,
      reason: event.reason ?? 'workflow_cancelled',
    });
  }

  // Attach clients have no keypress path of their own — the bus event is their only interrupt
  // signal. The engine publishes it at the moment the continuation prompt parks, so the park is
  // marked here; on the host the stop store owns that state instead.
  if (event.type === 'turn_interrupted') {
    const parked = markLifecycleInterruptParked(
      markLifecycleInterrupted(applyPhaseChange(state, phaseChanged, event.ts)),
    );
    if (event.at === 'boundary' && parked.status === 'interrupted') {
      return {
        ...parked,
        durationMs: parked.durationMs ?? durationFromStart(parked.startedAt, event.ts),
      };
    }
    return parked;
  }

  // A spawning runner call is proof the work resumed: it clears an event-set
  // interrupt for attach viewers. It cannot fight a live host interrupt — no
  // call spawns while the turn is parked, and the host clears via
  // markInterruptResumed at the submit that triggers the resume.
  if (event.type === 'runner_call_started') {
    return applyPhaseChange(
      clearLifecyclePaused(clearLifecycleInterrupted(state), event.ts),
      phaseChanged,
      event.ts,
    );
  }

  return applyPhaseChange(state, phaseChanged, event.ts);
}

export function updateQueueDepth(state: LifecycleState, event: EngineEvent): LifecycleState {
  let queuedMessageIds: Set<string>;
  if (event.type === 'message_queued') {
    if (state.queuedMessageIds.has(event.id)) return state;
    queuedMessageIds = new Set(state.queuedMessageIds);
    queuedMessageIds.add(event.id);
  } else if (event.type === 'message_injected_native') {
    if (!state.queuedMessageIds.has(event.id)) return state;
    queuedMessageIds = new Set(state.queuedMessageIds);
    queuedMessageIds.delete(event.id);
  } else if (event.type === 'queue_drained' || event.type === 'queue_cleared') {
    const ids = event.type === 'queue_drained' ? event.ids : undefined;
    const deliveredIds = ids ?? [...state.queuedMessageIds].slice(0, event.count);
    queuedMessageIds = new Set(state.queuedMessageIds);
    for (const id of deliveredIds) queuedMessageIds.delete(id);
    if (queuedMessageIds.size === state.queuedMessageIds.size) return state;
  } else {
    return state;
  }
  return { ...state, queuedMessageIds, queueDepth: queuedMessageIds.size };
}

// Phase changes also clear stall, but that rule lives in applyPhaseChange:
// updatePhase runs before updateStall in the addEvent reducer chain, so by the
// time updateStall sees the state the phase transition has already cleared it.
export function updateStall(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type === 'runner_call_stalled') {
    return {
      ...state,
      stall: {
        since: event.ts,
        silentMs: event.silentMs,
        runnerName: event.runnerName ?? null,
        ...(event.backendKind !== undefined && { backendKind: event.backendKind }),
      },
    };
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
    startedAt: state.startedAt,
    endedAt: cancellation.ts,
    durationMs: state.durationMs ?? durationFromStart(state.startedAt, cancellation.ts),
    reason: cancellation.reason,
  };
}

export function markLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'interrupted' };
}

export function markLifecyclePaused(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'running' && state.status !== 'interrupted') return state;
  return {
    ...state,
    status: 'paused',
    interruptParked: false,
    stall: null,
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

function markLifecycleComplete(state: LifecycleState, endedAt: number): LifecycleState {
  if (state.status === 'complete') return state;
  return {
    status: 'complete',
    interruptParked: false,
    cancelled: false,
    queueDepth: state.queueDepth,
    queuedMessageIds: state.queuedMessageIds,
    steerableCall: null,
    stall: null,
    startedAt: state.startedAt,
    endedAt,
    durationMs: state.durationMs ?? durationFromStart(state.startedAt, endedAt),
    reason: null,
  };
}

function durationFromStart(startedAt: number | null, endedAt: number): number {
  return Math.max(0, endedAt - (startedAt ?? endedAt));
}

function lifecycleStateFromReset(next: LifecycleResetState): LifecycleState {
  const queueDepth = next.queueDepth ?? initial.queueDepth;
  const queuedMessageIds = new Set(
    Array.from({ length: queueDepth }, (_, id) => `test-queue-${id}`),
  );
  const startedAt = next.startedAt ?? null;

  if (next.status === 'complete') {
    const endedAt = next.endedAt ?? startedAt ?? 0;
    return {
      status: 'complete',
      interruptParked: false,
      cancelled: false,
      queueDepth,
      queuedMessageIds,
      steerableCall: null,
      stall: null,
      lastRunnerEventTs: null,
      attemptStartedTs: null,
      startedAt,
      endedAt,
      durationMs: next.durationMs ?? durationFromStart(startedAt, endedAt),
      reason: null,
    };
  }

  if (next.cancelled || next.status === 'cancelled') {
    const endedAt = next.endedAt ?? startedAt ?? 0;
    return {
      status: 'cancelled',
      interruptParked: false,
      cancelled: true,
      queueDepth,
      queuedMessageIds,
      steerableCall: null,
      stall: null,
      lastRunnerEventTs: null,
      attemptStartedTs: null,
      startedAt,
      endedAt,
      durationMs: next.durationMs ?? durationFromStart(startedAt, endedAt),
      reason: next.reason ?? 'user_cancelled',
    };
  }

  if (next.status === 'interrupted') {
    return markLifecycleInterrupted(runningLifecycleState({ queuedMessageIds, startedAt }));
  }

  if (next.status === 'paused') {
    const running = runningLifecycleState({ queuedMessageIds, startedAt });
    return {
      ...running,
      status: 'paused',
      durationMs: next.durationMs ?? durationFromStart(startedAt, next.endedAt ?? Date.now()),
    };
  }

  if (next.status === 'running') {
    return runningLifecycleState({ queuedMessageIds, startedAt });
  }

  return {
    ...initial,
    queueDepth,
    queuedMessageIds,
  };
}

/** The first phase starts an idle run; a later phase change clears the stall of the one it left. */
function applyPhaseChange(
  state: LifecycleState,
  phaseChanged: boolean,
  ts: number,
): LifecycleState {
  if (!phaseChanged) return state;
  if (state.status === 'idle') {
    return runningLifecycleState({ queuedMessageIds: state.queuedMessageIds, startedAt: ts });
  }
  if (state.status === 'running' || state.status === 'interrupted' || state.status === 'paused') {
    return { ...state, stall: null };
  }
  return state;
}

function runningLifecycleState(input: {
  queuedMessageIds: ReadonlySet<string>;
  startedAt: number | null;
  lastRunnerEventTs?: number | null;
  attemptStartedTs?: number | null;
  resumedAt?: number | null;
}): RunningLifecycleState {
  return {
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: input.queuedMessageIds.size,
    queuedMessageIds: input.queuedMessageIds,
    steerableCall: null,
    stall: null,
    lastRunnerEventTs: input.lastRunnerEventTs ?? null,
    attemptStartedTs: input.attemptStartedTs ?? null,
    plannerCall: null,
    plannerCallStartedTs: null,
    waitingSince: null,
    waitedMs: {},
    resumedAt: input.resumedAt ?? null,
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
}
