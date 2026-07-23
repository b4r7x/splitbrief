import { describe, expect, it } from 'vitest';
import {
  INFRASTRUCTURE_PHASE_EVENT_TYPES,
  eventPhase,
  isInfrastructurePhaseEvent,
} from './event-phase.js';

describe('isInfrastructurePhaseEvent', () => {
  it.each(INFRASTRUCTURE_PHASE_EVENT_TYPES)('classifies %s as infrastructure', (type) => {
    expect(isInfrastructurePhaseEvent({ type })).toBe(true);
  });

  it('does not classify workflow lifecycle events as infrastructure', () => {
    expect(isInfrastructurePhaseEvent({ type: 'workflow_started' })).toBe(false);
  });
});

describe('eventPhase', () => {
  it('returns a validated phase when present', () => {
    expect(eventPhase({ phase: 'implementing' })).toBe('implementing');
  });

  it('returns undefined for invalid or missing phase', () => {
    expect(eventPhase({ phase: 'not-a-phase' })).toBeUndefined();
    expect(eventPhase({})).toBeUndefined();
  });
});
