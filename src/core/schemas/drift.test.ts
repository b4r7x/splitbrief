import { describe, expect, it } from 'vitest';
import { DriftReportSchema } from './drift.js';

describe('DriftReportSchema', () => {
  it('opens a report an older run saved with a score and a retired out-of-bounds finding', () => {
    const parsed = DriftReportSchema.parse({
      version: 1,
      passed: false,
      score: 0.75,
      changedFiles: ['src/a.ts'],
      expectedFiles: [],
      findings: [
        {
          severity: 'error',
          code: 'out_of_bounds_text_match',
          message: 'Out-of-bounds pattern "SECRET" appears in diff.',
        },
        {
          severity: 'info',
          code: 'out_of_scope_file',
          file: 'src/a.ts',
          message: 'src/a.ts touched, not suggested by any task.',
        },
      ],
    });

    expect(parsed).not.toHaveProperty('score');
    expect(parsed.findings.map((finding) => finding.code)).toEqual(['out_of_scope_file']);
  });
});
