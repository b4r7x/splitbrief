import type { EventBus } from "../../events/types.js";
import type { Phase } from "../../../core/schemas/enums.js";

export const HEARTBEAT_THRESHOLD_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 2000;

interface HeartbeatState {
  accumulatedTokens: number;
  phaseHint: string | undefined;
}

interface HeartbeatHandle {
  updateTokens(tokens: number): void;
  updatePhaseHint(hint: string): void;
  stop(): void;
}

export function startPlannerHeartbeat(
  bus: EventBus,
  phase: Phase,
  startTime: number,
): HeartbeatHandle {
  const state: HeartbeatState = { accumulatedTokens: 0, phaseHint: undefined };
  let timer: ReturnType<typeof setInterval> | null = null;
  const publish = () => {
    bus.publish({
      type: "planner_heartbeat",
      ts: Date.now(),
      phase,
      elapsedMs: Date.now() - startTime,
      accumulatedTokens: state.accumulatedTokens,
      ...(state.phaseHint !== undefined ? { phaseHint: state.phaseHint } : {}),
    });
  };

  const threshold = setTimeout(() => {
    publish();
    timer = setInterval(publish, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_THRESHOLD_MS);

  return {
    updateTokens(tokens: number): void {
      state.accumulatedTokens = tokens;
    },
    updatePhaseHint(hint: string): void {
      state.phaseHint = hint;
    },
    stop(): void {
      clearTimeout(threshold);
      if (timer !== null) clearInterval(timer);
    },
  };
}
