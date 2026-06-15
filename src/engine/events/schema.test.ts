import { describe, expect, it } from 'vitest';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent } from './types.js';

describe('EngineEvent alias colocation with EngineEventSchema', () => {
  it('parseEngineEvent (schema.ts) yields a value usable as the EngineEvent alias (types.ts)', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 7,
      phase: 'idle',
      feature: 'demo',
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const event: EngineEvent = parsed;
    expect(event.type).toBe('workflow_started');
    expect(event.ts).toBe(7);
  });

  it('round-trips a discriminated variant through the schema without losing fields', () => {
    const input = {
      type: 'task_completed' as const,
      ts: 3,
      phase: 'implementing' as const,
      taskId: 'T001',
      title: 'Finish task',
      method: 'local' as const,
      retries: 0,
      duration: 10,
    };
    const parsed = parseEngineEvent(input);
    expect(parsed).toEqual(expect.objectContaining(input));
  });
});

describe('parseEngineEvent', () => {
  it('accepts known events with required variant fields', () => {
    expect(
      parseEngineEvent({
        type: 'task_completed',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        title: 'Finish task',
        method: 'local',
        retries: 0,
        duration: 10,
      }),
    ).toEqual(expect.objectContaining({ type: 'task_completed' }));
  });

  it('rejects unknown event types', () => {
    expect(parseEngineEvent({ type: 'not_real', ts: 1, phase: 'idle' })).toBeNull();
  });

  it('rejects known events missing required variant fields', () => {
    expect(parseEngineEvent({ type: 'task_completed', ts: 1, phase: 'implementing' })).toBeNull();
  });

  it('preserves unknown keys on parsed events', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 1,
      phase: 'idle',
      feature: 'demo',
      forwardCompatField: { nested: true },
    });
    expect(parsed).toMatchObject({ forwardCompatField: { nested: true } });
  });
});
