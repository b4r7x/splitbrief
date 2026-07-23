import type { EngineEvent } from '../../../src/engine/events/types.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export function makePlannerStatus(
  overrides?: Partial<EventOfType<'planner_status'>>,
): EventOfType<'planner_status'> {
  return {
    type: 'planner_status',
    ts: Date.now(),
    phase: 'implementing',
    status: 'running',
    ...overrides,
  };
}

export function makePlannerText(
  overrides?: Partial<EventOfType<'planner_text'>>,
): EventOfType<'planner_text'> {
  return {
    type: 'planner_text',
    ts: Date.now(),
    phase: 'implementing',
    text: 'Planning...',
    ...overrides,
  };
}

export function makePlannerHeartbeat(
  overrides?: Partial<EventOfType<'planner_heartbeat'>>,
): EventOfType<'planner_heartbeat'> {
  return {
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: 'researching',
    elapsedMs: 500,
    accumulatedTokens: 5,
    ...overrides,
  };
}
