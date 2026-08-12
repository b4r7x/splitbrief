import { describe, expect, it } from 'vitest';
import { parseEngineEvent } from '../../../src/engine/events/schema.js';
import { makeRunnerCallActivity } from './runner-call.js';

describe('makeRunnerCallActivity', () => {
  it('creates a schema-valid implementer command activity', () => {
    const event = makeRunnerCallActivity('implementer-command');

    expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
  });

  it('creates a schema-valid planner read activity', () => {
    const event = makeRunnerCallActivity('planner-read');

    expect(event).toMatchObject({
      role: 'planner',
      phase: 'researching',
      kind: 'read',
      stage: 'updated',
    });
    expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
  });

  it('keeps object-form overrides isolated from scenario-only fields', () => {
    const event = makeRunnerCallActivity({ label: 'reading src/app.ts', kind: 'read' });

    expect(event).toMatchObject({
      label: 'reading src/app.ts',
      kind: 'read',
    });
    expect(event).not.toHaveProperty('target');
  });

  it('keeps raw, redaction, and identity fields as typed overrides', () => {
    const event = makeRunnerCallActivity('implementer-command', {
      callId: 'call-raw',
      activityId: 'call-raw:tool:2',
      redacted: true,
      rawAvailable: true,
      expandId: 'raw-2',
      textPartial: 'stdout',
      diagnosticPartial: 'stderr',
    });

    expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
  });
});
