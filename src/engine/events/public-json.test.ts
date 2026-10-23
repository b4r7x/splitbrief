import { describe, expect, it } from 'vitest';
import { boundHeadlessJsonRecord } from './public-json.js';
import type { EngineEventOf } from './types.js';

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

  it('carries the round a reply in words answers on its user_message event', () => {
    const reply: EngineEventOf<'user_message'> = {
      type: 'user_message',
      ts: 1,
      phase: 'planning',
      text: 'Keep it.',
      questions: [{ id: 'q1', type: 'confirm', text: 'Keep the public API?' }],
    };

    expect(boundHeadlessJsonRecord({ type: 'event', data: reply })).toEqual({
      type: 'event',
      data: reply,
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

  it('carries the halt and the recovery status through so a machine consumer can tell them apart', () => {
    for (const status of ['awaiting-user', 'applying'] as const) {
      expect(
        boundHeadlessJsonRecord({
          type: 'recovery_required',
          sessionId: 'sess-1',
          halt: 'seat-down',
          reason: 'context-overflow',
          status,
          message: 'overflow',
          availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
          recommendedAction: 'retry-same-worker',
          resumeCommand: 'splitbrief continue sess-1 --action retry',
        }),
      ).toMatchObject({ type: 'recovery_required', halt: 'seat-down', status });
    }
  });

  it('still parses a recovery_required record without a status', () => {
    expect(
      boundHeadlessJsonRecord({
        type: 'recovery_required',
        sessionId: 'sess-1',
        halt: 'needs-you',
        reason: 'apply-conflict',
        message: 'Apply found 1 conflicting file',
        availableActions: ['retry-same-worker', 'end-run'],
        recommendedAction: 'retry-same-worker',
        resumeCommand: 'splitbrief continue sess-1 --action retry',
      }),
    ).toMatchObject({
      type: 'recovery_required',
      sessionId: 'sess-1',
      halt: 'needs-you',
      reason: 'apply-conflict',
    });
  });

  it.each([false, true])('writes a ready_to_apply record with override %s as given', (override) => {
    const record = {
      type: 'ready_to_apply' as const,
      sessionId: 'sess-1',
      override,
      applyCommand: 'splitbrief continue sess-1 --action apply',
      discardCommand: 'splitbrief continue sess-1 --action discard',
    };

    expect(boundHeadlessJsonRecord(record)).toEqual(record);
  });
});
