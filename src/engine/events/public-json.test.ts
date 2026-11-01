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
      message: expect.stringContaining('Omitted oversized readiness_report record'),
    });
  });

  it('turns a record that fails its schema into a warning record', () => {
    expect(
      boundHeadlessJsonRecord({
        type: 'final_review_failed',
        sessionId: 'sess-1',
        blocking: Number.NaN,
      }),
    ).toEqual({ type: 'warning', message: 'Omitted invalid final_review_failed record' });
  });

  it('keeps the halt on an oversized recovery_required record and leaves out its files', () => {
    const halt = {
      type: 'recovery_required' as const,
      sessionId: 'sess-1',
      halt: 'needs-you' as const,
      reason: 'apply-conflict' as const,
      status: 'awaiting-user' as const,
      message: 'Apply found 7000 conflicting files',
      availableActions: ['retry-same-worker' as const, 'end-run' as const],
      recommendedAction: 'retry-same-worker' as const,
      resumeCommand: 'splitbrief continue sess-1 --action retry',
    };
    const files = Array.from(
      { length: 7000 },
      (_value, index) => `src/generated/module-${String(index).padStart(5, '0')}/index.ts`,
    );

    expect(boundHeadlessJsonRecord({ ...halt, files })).toEqual(halt);
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
