import { eventPhase, isInfrastructurePhaseEvent } from '../../core/event-phase.js';
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

type RunningPhase = Exclude<Phase, 'complete'>;
type LifecycleStatus = 'idle' | 'running' | 'interrupted' | 'paused' | 'complete' | 'cancelled';
type PhaseFirstSeenTs = Readonly<Partial<Record<Phase, number>>>;

type LifecycleStall = {
  since: number;
  silentMs: number;
  runnerName: string | null;
  /** The backend kind of the stalled call; absent on records written before kinds. */
  backendKind?: RunnerKind | undefined;
} | null;

interface LifecycleBase {
  queueDepth: number;
  phaseFirstSeenTs: PhaseFirstSeenTs;
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
  /** Run time of the stretches before the one the run is on: a park between them is not run. */
  bankedRunMs?: number;
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

// A paused run read back from disk knows when it last did anything, so its clock can be frozen
// there; a live park has no end yet and leaves both null.
interface PausedLifecycleState extends LifecycleBase {
  phase: RunningPhase;
  status: 'paused';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  reason: null;
}

interface CompleteLifecycleState extends LifecycleBase {
  phase: Phase;
  status: 'complete';
  interruptParked: false;
  cancelled: false;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
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
  | PausedLifecycleState
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

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: LifecycleResetState): void {
  store.set(next ? lifecycleStateFromReset(next) : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
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

export function updatePhase(state: LifecycleState, event: EngineEvent): LifecycleState {
  return updatePlannerCall(updatePhaseOnly(updateRunClocks(state, event), event), event);
}

function updatePhaseOnly(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (isInfrastructurePhaseEvent(event)) return state;
  const phase = eventPhase(event);

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
      resumedAt: event.ts,
      bankedRunMs: bankedAtResume(state),
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

  // Attach clients have no keypress path of their own — the bus event is their only interrupt
  // signal. The engine publishes it at the moment the continuation prompt parks, so the park is
  // marked here; on the host the stop store owns that state instead.
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
    return applyRunningPhase(
      clearLifecyclePaused(clearLifecycleInterrupted(state), event.ts),
      phase,
      event.ts,
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

// Phase changes also clear stall, but that rule lives in applyRunningPhase:
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
    durationMs: state.durationMs ?? runMsAt(state, cancellation.ts),
    reason: cancellation.reason,
  };
}

export function markLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'interrupted' };
}

// A park stops the run clock where it stands; the park itself is no run time.
export function markLifecyclePaused(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'running' && state.status !== 'interrupted') return state;
  return {
    ...state,
    status: 'paused',
    interruptParked: false,
    stall: null,
    durationMs: runMsAt(state, ts),
  };
}

// A wait is the byline clock stopping on the user: a question, a review gate, an approval. One wait
// is open at a time, and a prompt that supersedes another keeps the same wait open.
export function markLifecycleWaitStarted(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'running' || (state.waitingSince ?? null) !== null) return state;
  return { ...state, waitingSince: ts };
}

export function markLifecycleWaitEnded(state: LifecycleState, ts: number): LifecycleState {
  const since = state.waitingSince ?? null;
  if (since === null) return state;
  const waited = (state.waitedMs?.[state.phase] ?? 0) + Math.max(0, ts - since);
  return { ...state, waitingSince: null, waitedMs: { ...state.waitedMs, [state.phase]: waited } };
}

export function markLifecycleInterruptParked(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted' || state.interruptParked) return state;
  return { ...state, interruptParked: true };
}

export function clearLifecycleInterrupted(state: LifecycleState): LifecycleState {
  if (state.status !== 'interrupted') return state;
  return { ...state, status: 'running', interruptParked: false };
}

// A parked run has no event of its own to un-park it: the next call spawning is the proof that the
// steer landed and the work carried on.
export function clearLifecyclePaused(state: LifecycleState, ts: number): LifecycleState {
  if (state.status !== 'paused') return state;
  // A run that is moving again has no end and no duration: the frozen clock a run at rest carried
  // belongs to the pause it just left. Its stage clock starts again here, so the waits it already
  // subtracted go with it.
  return {
    ...state,
    status: 'running',
    endedAt: null,
    durationMs: null,
    resumedAt: ts,
    bankedRunMs: bankedAtResume(state),
    waitedMs: {},
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
    interruptParked: false,
    cancelled: false,
    queueDepth: state.queueDepth,
    phaseFirstSeenTs: withPhaseFirstSeen(state.phaseFirstSeenTs, phase, endedAt),
    stall: null,
    startedAt: state.startedAt,
    endedAt,
    durationMs: state.durationMs ?? runMsAt(state, endedAt),
    reason: null,
  };
}

/**
 * The run time at `ts`: the stretches already banked plus the one the run is on, which opened at
 * its start or at its last resume. The time a run sat parked or stopped between them is no run
 * time.
 */
export function runMsAt(state: LifecycleState, ts: number): number {
  const stretchStart = state.resumedAt ?? state.startedAt;
  return (state.bankedRunMs ?? 0) + (stretchStart === null ? 0 : Math.max(0, ts - stretchStart));
}

/** The run clock: how long the run has run by `now`, or `null` before it started. */
export function runElapsedMs(state: LifecycleState, now: number): number | null {
  if (state.durationMs !== null) return state.durationMs;
  return state.startedAt === null ? null : runMsAt(state, now);
}

// A stopped run already holds its run time. One still running when the next stretch opens — a log
// whose process died — ran until it last heard from a seat, not until the resume.
function bankedAtResume(state: LifecycleState): number {
  return state.durationMs ?? runMsAt(state, state.lastRunnerEventTs ?? state.resumedAt ?? 0);
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
      phase,
      status: 'cancelled',
      interruptParked: false,
      cancelled: true,
      queueDepth,
      phaseFirstSeenTs,
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
    return markLifecycleInterrupted(
      runningLifecycleState({ phase, queueDepth, phaseFirstSeenTs, startedAt }),
    );
  }

  if (next.status === 'paused') {
    const running = runningLifecycleState({ phase, queueDepth, phaseFirstSeenTs, startedAt });
    return {
      ...running,
      status: 'paused',
      durationMs: next.durationMs ?? runMsAt(running, next.endedAt ?? Date.now()),
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
  if (state.status === 'running' || state.status === 'interrupted' || state.status === 'paused') {
    return { ...state, phase: runningPhase(phase), phaseFirstSeenTs, stall: null };
  }
  return { ...state, phase, phaseFirstSeenTs };
}

function runningLifecycleState(input: {
  phase: Phase;
  queueDepth: number;
  phaseFirstSeenTs: PhaseFirstSeenTs;
  startedAt: number | null;
  lastRunnerEventTs?: number | null;
  attemptStartedTs?: number | null;
  resumedAt?: number | null;
  bankedRunMs?: number;
}): RunningLifecycleState {
  return {
    phase: runningPhase(input.phase),
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: input.queueDepth,
    phaseFirstSeenTs: input.phaseFirstSeenTs,
    stall: null,
    lastRunnerEventTs: input.lastRunnerEventTs ?? null,
    attemptStartedTs: input.attemptStartedTs ?? null,
    plannerCall: null,
    plannerCallStartedTs: null,
    waitingSince: null,
    waitedMs: {},
    resumedAt: input.resumedAt ?? null,
    ...(input.bankedRunMs !== undefined && { bankedRunMs: input.bankedRunMs }),
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
}

function runningPhase(phase: Phase): RunningPhase {
  return phase === 'complete' ? 'idle' : phase;
}
