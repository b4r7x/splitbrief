import { describe, expect, it } from 'vitest';
import { ReviewFindingCountsSchema, ReviewVerdictSchema } from '../../core/schemas/summary.js';
import { parseFinalReview } from './final-review.js';

const EXACT_FORMAT_REVIEW = `# Final Implementation Review

### Verdict
pass

### Criteria Results
- **[PASS]** Acceptance criteria are all satisfied -- the endpoint returns 201 for valid input
- **[PASS]** All inputs are handled and processing is correct
- **[FAIL]** Error handling misses the invalid-token case -- unauthenticated calls return 500 instead of 401

### Findings
- **Critical**: Unauthenticated requests return 500 instead of 401, breaking the error contract
- **Warning**: The retry loop can spin twice on a flaky connection
- **Note**: Consider extracting the guard into a shared helper

### Summary
Solid implementation overall; the error-handling gap needs a fix.`;

describe('parseFinalReview', () => {
  it('parses a review in the prompt exact format into verdict, criteria and findings', () => {
    const parsed = parseFinalReview(EXACT_FORMAT_REVIEW);

    expect(parsed.verdict).toBe('pass');
    expect(parsed.criteria).toEqual([
      {
        passed: true,
        text: 'Acceptance criteria are all satisfied -- the endpoint returns 201 for valid input',
      },
      { passed: true, text: 'All inputs are handled and processing is correct' },
      {
        passed: false,
        text: 'Error handling misses the invalid-token case -- unauthenticated calls return 500 instead of 401',
      },
    ]);
    expect(parsed.findings).toEqual([
      {
        severity: 'critical',
        text: 'Unauthenticated requests return 500 instead of 401, breaking the error contract',
      },
      { severity: 'warning', text: 'The retry loop can spin twice on a flaky connection' },
      { severity: 'note', text: 'Consider extracting the guard into a shared helper' },
    ]);
  });

  it('reports no verdict rather than guessing when no verdict section exists', () => {
    const parsed = parseFinalReview(
      `### Criteria Results
- **[PASS]** The build is green

### Findings
- **Warning**: Minor nit`,
    );

    expect(parsed.verdict).toBeNull();
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.findings).toHaveLength(1);
  });

  it('ignores verdict words that appear in prose outside the verdict section', () => {
    const parsed = parseFinalReview(
      `The implementation will pass all checks and could fail a stricter review.

### Verdict
pass_with_notes

### Criteria Results
- **[PASS]** The build is green`,
    );

    expect(parsed.verdict).toBe('pass_with_notes');
  });

  it('ignores findings bullets without a severity label', () => {
    const parsed = parseFinalReview(
      `### Verdict
fail

### Findings
- **Critical**: The module does not compile
- This finding has no severity label and must be ignored
- **Warning**: A minor issue`,
    );

    expect(parsed.findings).toEqual([
      { severity: 'critical', text: 'The module does not compile' },
      { severity: 'warning', text: 'A minor issue' },
    ]);
  });

  it('returns a null verdict when the verdict section carries more than one verdict word', () => {
    const parsed = parseFinalReview(
      `### Verdict
pass with minor notes -- not a fail, but close

### Findings
- **Note**: Nothing`,
    );

    expect(parsed.verdict).toBeNull();
  });

  it('produces every verdict the persisted review packet accepts, and no other', () => {
    const produced = ReviewVerdictSchema.options.map(
      (verdict) => parseFinalReview(`### Verdict\n${verdict}`).verdict,
    );

    expect(produced).toEqual([...ReviewVerdictSchema.options]);
    expect(parseFinalReview('### Verdict\ndefer').verdict).toBeNull();
  });

  it('produces every finding severity the packet finding counter tallies', () => {
    const severities = Object.keys(ReviewFindingCountsSchema.shape);
    const review = severities.map((severity) => `- **${severity}**: ${severity} body`).join('\n');

    const parsed = parseFinalReview(`### Findings\n${review}`);

    expect(parsed.findings).toEqual(
      severities.map((severity) => ({ severity, text: `${severity} body` })),
    );
  });
});
