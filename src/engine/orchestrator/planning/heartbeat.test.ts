import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_THRESHOLD_MS, startPlannerHeartbeat } from './heartbeat.js';
import type { EngineEvent } from '../../events/types.js';

function createMockBus() {
  const published: EngineEvent[] = [];
  return {
    published,
    publish(event: EngineEvent) {
      published.push(event);
    },
    subscribe() {
      return () => {};
    },
  };
}

describe('startPlannerHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes heartbeat events only after the threshold and then at each interval', () => {
    const bus = createMockBus();
    startPlannerHeartbeat(bus, 'planning', Date.now());

    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS - 1);
    expect(bus.published).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!;
    expect(event.type).toBe('planner_heartbeat');
    if (event.type === 'planner_heartbeat') {
      expect(event.phase).toBe('planning');
      expect(event.elapsedMs).toBeGreaterThanOrEqual(HEARTBEAT_THRESHOLD_MS);
    }

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(bus.published).toHaveLength(2);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(bus.published).toHaveLength(3);
  });

  it('includes the latest token and phase hint metadata in heartbeat events', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    handle.updateTokens(750);
    handle.updatePhaseHint('analyzing repo map');

    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!;
    if (event.type === 'planner_heartbeat') {
      expect(event.accumulatedTokens).toBe(750);
      expect(event.phaseHint).toBe('analyzing repo map');
    }

    handle.updateTokens(1200);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    const second = bus.published[1]!;
    if (second.type === 'planner_heartbeat') {
      expect(second.accumulatedTokens).toBe(1200);
      expect(second.phaseHint).toBe('analyzing repo map');
    }
  });

  it('stops future heartbeat events whether stopped before or after the first heartbeat', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);

    handle.stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(bus.published).toHaveLength(1);

    const stoppedEarlyBus = createMockBus();
    const stoppedEarly = startPlannerHeartbeat(stoppedEarlyBus, 'planning', Date.now());
    stoppedEarly.stop();
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS + HEARTBEAT_INTERVAL_MS * 5);
    expect(stoppedEarlyBus.published).toHaveLength(0);
  });
});
