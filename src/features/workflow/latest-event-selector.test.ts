import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../engine/events/types.js';
import { createLatestEventByTypeSelector } from './latest-event-selector.js';

const baseStatus: Extract<EngineEvent, { type: 'planner_status' }> = {
  type: 'planner_status',
  ts: 1,
  phase: 'planning',
  status: 'running',
};

describe('createLatestEventByTypeSelector', () => {
  it('returns the cached latest event for unrelated appended events', () => {
    const selector = createLatestEventByTypeSelector('planner_status');
    const firstEvents: EngineEvent[] = [baseStatus];
    const first = selector({ events: firstEvents });

    const next = selector({
      events: [...firstEvents, { type: 'warning', ts: 2, phase: 'planning', message: 'noise' }],
    });

    expect(next).toBe(first);
  });

  it('updates when a matching event is appended', () => {
    const selector = createLatestEventByTypeSelector('planner_status');
    selector({ events: [baseStatus] });
    const doneStatus: Extract<EngineEvent, { type: 'planner_status' }> = {
      ...baseStatus,
      ts: 3,
      status: 'done',
      duration: 200,
    };

    expect(selector({ events: [baseStatus, doneStatus] })).toBe(doneStatus);
  });

  it('falls back to a full scan when the cached event object is rewritten', () => {
    const selector = createLatestEventByTypeSelector('planner_status');
    selector({ events: [baseStatus] });
    const rewrittenStatus: Extract<EngineEvent, { type: 'planner_status' }> = {
      ...baseStatus,
      status: 'done',
    };

    expect(selector({ events: [rewrittenStatus] })).toBe(rewrittenStatus);
  });
});
