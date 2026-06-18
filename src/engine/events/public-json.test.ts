import { describe, expect, it } from 'vitest';
import { HeadlessJsonRecordSchema, protectHeadlessJsonRecord } from './public-json.js';

describe('HeadlessJsonRecordSchema', () => {
  it('validates public event envelopes', () => {
    expect(
      HeadlessJsonRecordSchema.parse({
        type: 'event',
        data: { type: 'workflow_started', ts: 1, phase: 'idle', feature: 'build x' },
      }),
    ).toEqual({
      type: 'event',
      data: { type: 'workflow_started', ts: 1, phase: 'idle', feature: 'build x' },
    });
  });

  it('validates named recovery records', () => {
    expect(
      HeadlessJsonRecordSchema.parse({
        type: 'recovery_required',
        sessionId: 'session-1',
        reason: 'retry-exhausted',
        message: 'failed',
        availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
        recommendedAction: 'pause-run',
      }),
    ).toMatchObject({ type: 'recovery_required', reason: 'retry-exhausted' });
  });
});

describe('protectHeadlessJsonRecord', () => {
  it('redacts secrets before writing public records', () => {
    expect(
      protectHeadlessJsonRecord({
        type: 'event',
        data: {
          type: 'warning',
          ts: 1,
          phase: 'planning',
          message: 'token sk-abcdefghijklmnopqrst',
        },
      }),
    ).toEqual({
      type: 'event',
      data: {
        type: 'warning',
        ts: 1,
        phase: 'planning',
        message: 'token sk-***REDACTED***',
      },
    });
  });

  it('turns oversized records into warning records', () => {
    const protectedRecord = protectHeadlessJsonRecord(
      {
        type: 'readiness_report',
        report: Array.from({ length: 500 }, (_value, index) => ({
          id: index,
          message: 'x'.repeat(100),
        })),
      },
      'otel',
    );

    expect(protectedRecord).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('omitted oversized readiness_report record'),
    });
  });
});
