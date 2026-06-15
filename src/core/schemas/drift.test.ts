import { describe, expect, it } from 'vitest';
import { DriftReportSchema } from './drift.js';

const baseReport = {
  version: 1 as const,
  passed: true,
  score: 1,
  changedFiles: [],
  expectedFiles: [],
  findings: [],
};

describe('DriftReportSchema score validation', () => {
  it('accepts a finite score', () => {
    const result = DriftReportSchema.safeParse(baseReport);
    expect(result.success).toBe(true);
  });

  it('rejects non-finite scores', () => {
    expect(
      DriftReportSchema.safeParse({ ...baseReport, score: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(DriftReportSchema.safeParse({ ...baseReport, score: Number.NaN }).success).toBe(false);
  });
});
