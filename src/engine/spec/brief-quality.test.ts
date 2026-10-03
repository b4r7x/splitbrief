import { describe, it, expect } from 'vitest';
import { isBriefQualityReport } from './brief-quality.js';

describe('isBriefQualityReport', () => {
  it('accepts a valid persisted report', () => {
    expect(
      isBriefQualityReport({
        version: 1,
        passed: false,
        score: 0.8,
        issues: [
          {
            taskId: 'T001',
            severity: 'error',
            code: 'missing_scope',
            message: 'Task T001 has no scope definition',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects invalid report shapes', () => {
    expect(
      isBriefQualityReport({
        version: 1,
        passed: true,
        score: '1.00',
        issues: [],
      }),
    ).toBe(false);
    expect(
      isBriefQualityReport({
        version: 1,
        passed: true,
        score: 1,
        issues: [{ taskId: 'T001', severity: 'error', code: 'unknown', message: 'bad' }],
      }),
    ).toBe(false);
  });
});
