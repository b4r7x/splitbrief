import {
  briefMarkTaskId,
  endsBriefClock,
  foldBriefClock,
  type BriefClockState,
} from '../../../core/brief-clock.js';
import { isInfrastructurePhaseEvent } from '../../../core/phases/of-event.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import {
  markLifecycleComplete,
  markLifecycleCancellationRequested,
  markLifecycleInterruptParked,
  markLifecycleInterrupted,
  durationFromStart,
  clearLifecyclePaused,
  clearLifecycleInterrupted,
} from './marks.js';
import type { LifecycleState, RunningLifecycleState } from './types.js';

const STALL_CLEARING_EVENT_TYPES = new Set<EngineEvent['type']>([
  'runner_call_stall_cleared',
  'runner_call_activity',
  'runner_call_completed',
  'runner_call_error',
  'planner_text',
]);

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

/** The two clocks the build-progress block reads: last sign of life, and the brief's time. */
function updateRunClocks(state: LifecycleState, event: EngineEvent): LifecycleState {
  const lastRunnerEventTs = RUNNER_HEARTBEAT_EVENT_TYPES.has(event.type)
    ? event.ts
    : (state.lastRunnerEventTs ?? null);
  const previousClock = state.briefClock ?? null;
  let briefClock = previousClock;
  if (!isInfrastructurePhaseEvent(event)) {
    const markTaskId = narrowRecord(event)?.taskId;
    const taskId = briefMarkTaskId({
      taskId: typeof markTaskId === 'string' ? markTaskId : undefined,
      ...(event.type === 'turn_interrupted' && { at: event.at, step: event.step }),
    });
    if (event.type === 'workflow_started') {
      briefClock = null;
    } else {
      if (event.type === 'task_started' && taskId !== undefined && briefClock?.taskId !== taskId) {
        briefClock = { taskId, workedMs: 0, stretch: null, cut: false };
      }
      if (briefClock !== null) {
        const mark = { type: event.type, ts: event.ts, ...(taskId !== undefined && { taskId }) };
        briefClock = endsBriefClock(briefClock, mark) ? null : foldBriefClock(briefClock, mark);
      }
    }
  }
  if (lastRunnerEventTs === state.lastRunnerEventTs && briefClock === previousClock) {
    return state;
  }
  return { ...state, lastRunnerEventTs, briefClock };
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
  const clocked = updateRunClocks(state, event);
  if (event.type === 'steerable_call') {
    const steerableCall =
      event.seat === undefined
        ? null
        : { seat: event.seat, ...(event.taskId !== undefined && { taskId: event.taskId }) };
    return { ...clocked, steerableCall };
  }
  return updatePlannerCall(updatePhaseOnly(clocked, event, phaseChanged), event);
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
      briefClock: state.briefClock ?? null,
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
    const resumed = applyPhaseChange(
      clearLifecyclePaused(clearLifecycleInterrupted(state), event.ts),
      phaseChanged,
      event.ts,
    );
    return resumed.retry === null ? resumed : { ...resumed, retry: null };
  }

  if (event.type === 'seat_retry') {
    const retrying = applyPhaseChange(state, phaseChanged, event.ts);
    if (retrying.status !== 'running') return retrying;
    return { ...retrying, retry: { attempt: event.attempt, delayMs: event.delayMs } };
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

/** The first phase starts an idle run; a later phase change clears the stall of the one it left. */
function applyPhaseChange(
  state: LifecycleState,
  phaseChanged: boolean,
  ts: number,
): LifecycleState {
  if (!phaseChanged) return state;
  if (state.status === 'idle') {
    return runningLifecycleState({
      queuedMessageIds: state.queuedMessageIds,
      startedAt: ts,
      briefClock: state.briefClock ?? null,
    });
  }
  if (state.status === 'running' || state.status === 'interrupted' || state.status === 'paused') {
    return { ...state, stall: null, retry: null };
  }
  return state;
}

export function runningLifecycleState(input: {
  queuedMessageIds: ReadonlySet<string>;
  startedAt: number | null;
  lastRunnerEventTs?: number | null;
  briefClock?: BriefClockState | null;
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
    retry: null,
    lastRunnerEventTs: input.lastRunnerEventTs ?? null,
    briefClock: input.briefClock ?? null,
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
