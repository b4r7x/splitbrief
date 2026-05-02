import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startPlannerHeartbeat, HEARTBEAT_THRESHOLD_MS, HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
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

  it('does not fire before threshold', () => {
    const bus = createMockBus();
    startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS - 1);
    expect(bus.published).toHaveLength(0);
  });

  it('fires after the threshold with correct elapsed time', () => {
    const bus = createMockBus();
    const startTime = Date.now();
    startPlannerHeartbeat(bus, 'planning', startTime);
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!;
    expect(event.type).toBe('planner_heartbeat');
    if (event.type === 'planner_heartbeat') {
      expect(event.phase).toBe('planning');
      expect(event.elapsedMs).toBeGreaterThanOrEqual(HEARTBEAT_THRESHOLD_MS);
    }
  });

  it('fires every interval after the threshold', () => {
    const bus = createMockBus();
    startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(bus.published).toHaveLength(2);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(bus.published).toHaveLength(3);
  });

  it('tracks accumulatedTokens via updateTokens', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    handle.updateTokens(750);
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!;
    if (event.type === 'planner_heartbeat') {
      expect(event.accumulatedTokens).toBe(750);
    }
  });

  it('tracks phaseHint via updatePhaseHint', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    handle.updatePhaseHint('analyzing repo map');
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    const event = bus.published[0]!;
    if (event.type === 'planner_heartbeat') {
      expect(event.phaseHint).toBe('analyzing repo map');
    }
  });

  it('omits phaseHint when not set', () => {
    const bus = createMockBus();
    startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    const event = bus.published[0]!;
    if (event.type === 'planner_heartbeat') {
      expect(event.phaseHint).toBeUndefined();
    }
  });

  it('stop() prevents further events after interval started', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    handle.stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(bus.published).toHaveLength(1);
  });

  it('stop() prevents events when called before threshold', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    handle.stop();
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS + HEARTBEAT_INTERVAL_MS * 5);
    expect(bus.published).toHaveLength(0);
  });

  it('updates tokens reflected in subsequent heartbeats', () => {
    const bus = createMockBus();
    const handle = startPlannerHeartbeat(bus, 'planning', Date.now());
    vi.advanceTimersByTime(HEARTBEAT_THRESHOLD_MS);
    expect(bus.published).toHaveLength(1);
    handle.updateTokens(1200);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(bus.published).toHaveLength(2);
    const second = bus.published[1]!;
    if (second.type === 'planner_heartbeat') {
      expect(second.accumulatedTokens).toBe(1200);
    }
  });
});