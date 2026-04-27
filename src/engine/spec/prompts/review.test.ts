import { describe, it, expect } from 'vitest';
import { buildFinalReviewPrompt } from './review.js';

const SPEC = '## Spec\nAdd a hello function.';
const DIFF = '+export function hello() { return "hello"; }';

describe('buildFinalReviewPrompt', () => {
  it('returns a string without a drift section when driftReport is omitted', () => {
    const result = buildFinalReviewPrompt(SPEC, DIFF);
    expect(result).not.toContain('Deterministic Drift Report');
  });

  it('includes a drift section heading and content when driftReport is provided', () => {
    const driftSection = 'DRIFT: missing export in src/foo.ts';
    const result = buildFinalReviewPrompt(SPEC, DIFF, driftSection);
    expect(result).toContain('## Deterministic Drift Report');
    expect(result).toContain(driftSection);
  });

  it('intro text instructs treating error-level drift findings as review blockers', () => {
    const result = buildFinalReviewPrompt(SPEC, DIFF);
    expect(result).toContain(
      'Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.',
    );
  });
});
