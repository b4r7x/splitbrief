import { describe, it, expect } from 'vitest';
import { buildFinalReviewPrompt } from './review.js';

const SPEC = '## Spec\nAdd a hello function.';
const TASK_BRIEFS = '## Task T001\nAdd the hello export.';
const DIFF = '+export function hello() { return "hello"; }';

describe('buildFinalReviewPrompt', () => {
  it('returns a string without a drift section when driftReport is omitted', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(result).not.toContain('Deterministic Drift Report');
    expect(result).toContain('## Task Briefs');
    expect(result).toContain(TASK_BRIEFS);
    expect(result).toContain(
      'Treat error-level drift findings as review blockers unless you can clearly explain why they are false positives.',
    );
  });

  it('includes a drift section heading and content when driftReport is provided', () => {
    const driftSection = 'DRIFT: missing export in src/foo.ts';
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      driftReport: driftSection,
    });
    expect(result).toContain('## Deterministic Drift Report');
    expect(result).toContain(driftSection);
  });

  it('includes the recorded validation output verbatim and binds validation claims to it', () => {
    const evidence = '- test (`npm test`): passed\n\n```\nTests  4 passed (4)\n```';
    const result = buildFinalReviewPrompt({
      spec: SPEC,
      taskBriefs: TASK_BRIEFS,
      diff: DIFF,
      validationEvidence: evidence,
    });
    expect(result).toContain('## Recorded Validation Output');
    expect(result).toContain('Tests  4 passed (4)');
    expect(result).toContain(
      'quote the relevant line verbatim from the Recorded Validation Output section',
    );
    expect(result).toContain('never report counts or totals that do not appear there');
  });

  it('still instructs how to handle missing validation evidence when none is provided', () => {
    const result = buildFinalReviewPrompt({ spec: SPEC, taskBriefs: TASK_BRIEFS, diff: DIFF });
    expect(result).not.toContain('## Recorded Validation Output');
    expect(result).toContain(
      'state that validation output was not recorded instead of asserting results',
    );
  });
});
