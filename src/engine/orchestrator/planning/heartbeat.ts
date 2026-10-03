import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';

export const HEARTBEAT_THRESHOLD_MS = 5000;

export const PLANNER_KEEPALIVE_INTERVAL_MS = 2000;

interface HeartbeatState {
  callId: string | undefined;
}

interface HeartbeatHandle {
  updateCallId(callId: string): void;
  stop(): void;
}

export function startPlannerHeartbeat(
  bus: EventBus,
  phase: Phase,
  startTime: number,
): HeartbeatHandle {
  const state: HeartbeatState = {
    callId: undefined,
  };
  let windowStart = startTime;
  let timer: ReturnType<typeof setInterval> | null = null;
  const publish = () => {
    const now = Date.now();
    bus.publish({
      type: 'planner_heartbeat',
      ts: now,
      phase,
      elapsedMs: now - windowStart,
      // Nothing reports the call's tokens while it runs.
      accumulatedTokens: 0,
      ...(state.callId !== undefined ? { callId: state.callId } : {}),
    });
  };

  const threshold = setTimeout(() => {
    publish();
    timer = setInterval(publish, PLANNER_KEEPALIVE_INTERVAL_MS);
  }, HEARTBEAT_THRESHOLD_MS);

  return {
    updateCallId(callId: string): void {
      state.callId = callId;
      windowStart = Date.now();
    },
    stop(): void {
      clearTimeout(threshold);
      if (timer !== null) clearInterval(timer);
    },
  };
}
