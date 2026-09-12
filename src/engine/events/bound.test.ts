import { describe, expect, it } from 'vitest';
import { formatTaskId } from '../../core/schemas/task.js';
import { boundEngineEventForConsumer } from './bound.js';
import type { EngineEvent } from './types.js';

describe('boundEngineEventForConsumer', () => {
  it('redacts canonicalized runner activity before exposing persisted events', () => {
    const event: EngineEvent = {
      type: 'runner_call_activity',
      ts: 14,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:warning:1',
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'token sk-\u001b[31mabcdefghijklmnopqrstuvwxyz',
      redacted: false,
      rawAvailable: true,
      expandId: 'call-1:warning:1',
    };

    expect(boundEngineEventForConsumer(event, 'tui')).toMatchObject({
      type: 'runner_call_activity',
      activityId: 'call-1:warning:1',
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'token sk-***REDACTED***',
      redacted: true,
      rawAvailable: true,
      expandId: 'call-1:warning:1',
    });
  });

  it('redacts secrets and strips terminal controls from persisted events', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-abcdefghijklmnopqrst \u001b]0;owned\u0007done',
    };

    expect(boundEngineEventForConsumer(event, 'session-log')).toEqual({
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-***REDACTED*** done',
    });
  });

  it('keeps pre-redacted custom runner output intact', () => {
    expect(
      boundEngineEventForConsumer(
        {
          type: 'runner_call_text_delta',
          ts: 22,
          phase: 'planning',
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          sequence: 4,
          channel: 'assistant',
          text: 'helper output: ***REDACTED***',
        },
        'tui',
      ),
    ).toMatchObject({
      type: 'runner_call_text_delta',
      text: 'helper output: ***REDACTED***',
    });
  });

  it('truncates a single oversized string instead of dropping the event', () => {
    const bounded = boundEngineEventForConsumer(
      {
        type: 'planner_text',
        ts: 55,
        phase: 'planning',
        text: 'x'.repeat(2 * 1024 * 1024),
      },
      'session-log',
    );

    expect(bounded.type).toBe('planner_text');
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(512 * 1024);
  });

  it('replaces an event that stays oversized after bounding with a payload warning', () => {
    const event: EngineEvent = {
      type: 'tasks_planned',
      ts: 60,
      phase: 'planning',
      tasks: Array.from({ length: 20 }, (_, index) => ({
        id: formatTaskId(index + 1),
        title: 'x'.repeat(64 * 1024),
        index,
        file: 'src/a.ts',
        action: 'create' as const,
      })),
      total: 20,
    };

    const bounded = boundEngineEventForConsumer(event, 'session-log');

    expect(bounded).toMatchObject({
      type: 'warning',
      ts: 60,
      category: 'payload-bounds',
      code: 'payload_omitted',
    });
    expect(JSON.stringify(bounded)).not.toContain('xxxxxxxxxx');
  });
});
