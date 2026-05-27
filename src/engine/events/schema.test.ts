import { describe, expect, it } from 'vitest';
import { parseEngineEvent } from './schema.js';

describe('parseEngineEvent', () => {
  it('accepts known events with required variant fields', () => {
    expect(parseEngineEvent({
      type: 'task_completed',
      ts: 1,
      phase: 'implementing',
      taskId: 'T001',
      title: 'Finish task',
      method: 'local',
      retries: 0,
      duration: 10,
    })).toEqual(expect.objectContaining({ type: 'task_completed' }));
  });

  it('rejects unknown event types', () => {
    expect(parseEngineEvent({ type: 'not_real', ts: 1, phase: 'idle' })).toBeNull();
  });

  it('rejects known events missing required variant fields', () => {
    expect(parseEngineEvent({ type: 'task_completed', ts: 1, phase: 'implementing' })).toBeNull();
  });
});
