import { describe, expect, it } from 'vitest';
import { boundHeadlessJsonRecord } from './public-json.js';

describe('boundHeadlessJsonRecord', () => {
  it('redacts secrets before writing public records', () => {
    expect(
      boundHeadlessJsonRecord({
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
    const boundedRecord = boundHeadlessJsonRecord({
      type: 'readiness_report',
      report: Array.from({ length: 500 }, (_value, index) => ({
        id: index,
        message: 'x'.repeat(1000),
      })),
    });

    expect(boundedRecord).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('omitted oversized readiness_report record'),
    });
  });

  it('carries the recovery status through so a machine consumer can distinguish the three states', () => {
    for (const status of ['awaiting-user', 'paused', 'applying'] as const) {
      expect(
        boundHeadlessJsonRecord({
          type: 'recovery_required',
          sessionId: 'sess-1',
          reason: 'context-overflow',
          status,
          message: 'overflow',
          availableActions: ['pause-run', 'abort-workflow'],
          recommendedAction: 'pause-run',
        }),
      ).toMatchObject({ type: 'recovery_required', status });
    }
  });

  it('still parses a pre-change recovery_required record without a status', () => {
    expect(
      boundHeadlessJsonRecord({
        type: 'recovery_required',
        sessionId: 'sess-1',
        reason: 'context-overflow',
        message: 'overflow',
        availableActions: ['pause-run', 'abort-workflow'],
        recommendedAction: 'pause-run',
      }),
    ).toMatchObject({
      type: 'recovery_required',
      sessionId: 'sess-1',
      reason: 'context-overflow',
    });
  });
});
