import { describe, expect, it } from 'vitest';
import { protectHeadlessJsonRecord } from './public-json.js';

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
