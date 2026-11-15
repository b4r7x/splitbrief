import { createStore, storeBase } from '../../create.js';
import { durationFromStart, markLifecycleInterrupted } from './marks.js';
import { runningLifecycleState } from './phase.js';
import type { LifecycleState, LifecycleResetState } from './types.js';

const initial: LifecycleState = {
  status: 'idle',
  interruptParked: false,
  cancelled: false,
  queueDepth: 0,
  queuedMessageIds: new Set(),
  steerableCall: null,
  stall: null,
  retry: null,
  lastRunnerEventTs: null,
  briefClock: null,
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
      retry: null,
      lastRunnerEventTs: null,
      briefClock: null,
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
      retry: null,
      lastRunnerEventTs: null,
      briefClock: null,
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
