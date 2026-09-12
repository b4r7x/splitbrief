import type { EventBus } from '../../events/types.js';
import type { Phase } from '../../../core/schemas/enums.js';

export const HEARTBEAT_THRESHOLD_MS = 5000;

export const PLANNER_KEEPALIVE_INTERVAL_MS = 2000;

interface HeartbeatState {
  accumulatedTokens: number;
  phaseHint: string | undefined;
  callId: string | undefined;
}

interface HeartbeatHandle {
  updateTokens(tokens: number): void;
  updatePhaseHint(hint: string): void;
  updateCallId(callId: string): void;
  stop(): void;
}

export function startPlannerHeartbeat(
  bus: EventBus,
  phase: Phase,
  startTime: number,
): HeartbeatHandle {
  const state: HeartbeatState = {
    accumulatedTokens: 0,
    phaseHint: undefined,
    callId: undefined,
  };
  let windowStart = startTime;
  let timer: ReturnType<typeof setInterval> | null = null;
  let thresholdPassed = false;
  const publish = () => {
    const now = Date.now();
    bus.publish({
      type: 'planner_heartbeat',
      ts: now,
      phase,
      elapsedMs: now - windowStart,
      accumulatedTokens: state.accumulatedTokens,
      ...(state.callId !== undefined ? { callId: state.callId } : {}),
      ...(state.phaseHint !== undefined ? { phaseHint: state.phaseHint } : {}),
    });
  };

  const threshold = setTimeout(() => {
    thresholdPassed = true;
    publish();
    timer = setInterval(publish, PLANNER_KEEPALIVE_INTERVAL_MS);
  }, HEARTBEAT_THRESHOLD_MS);

  return {
    updateTokens(tokens: number): void {
      state.accumulatedTokens = tokens;
      if (thresholdPassed) publish();
    },
    updatePhaseHint(hint: string): void {
      state.phaseHint = hint;
    },
    updateCallId(callId: string): void {
      state.callId = callId;
      windowStart = Date.now();
      state.accumulatedTokens = 0;
    },
    stop(): void {
      clearTimeout(threshold);
      if (timer !== null) clearInterval(timer);
    },
  };
}
