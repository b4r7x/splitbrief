import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { REVIEW_CYCLE_CAP } from '../../core/pipeline-spec/review.js';
import { parseFinalReview } from '../parsers/final-review.js';
import { correctionFixes, decideReviewOutcome, type ReviewOutcomeInput } from './review-fix.js';

const tasks = [
  makeTask({ id: 'T001', file: 'src/alpha.ts' }),
  makeTask({ id: 'T002', file: 'src/beta.ts' }),
];

function reviewed(
  verdict: 'pass' | 'pass_with_notes' | 'fail' | null,
  findings: { severity: 'critical' | 'warning' | 'note'; text: string }[] = [],
): ReviewOutcomeInput {
  return { reviewStatus: 'written', verdict: { verdict, criteria: [], findings } };
}

describe('decideReviewOutcome', () => {
  it('passes a clean verdict and a pass_with_notes carrying only advisory findings', () => {
    expect(decideReviewOutcome(reviewed('pass'), tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'pass',
    });
    const notes = reviewed('pass_with_notes', [
      { severity: 'warning', text: 'src/alpha.ts is terse' },
    ]);
    expect(decideReviewOutcome(notes, tasks, REVIEW_CYCLE_CAP, 0)).toEqual({ kind: 'pass' });
  });

  it('sends a Critical finding back to the brief whose files it names', () => {
    const review = reviewed('fail', [
      { severity: 'critical', text: 'src/beta.ts writes the token to disk' },
      { severity: 'note', text: 'src/beta.ts could use a comment' },
    ]);
    expect(decideReviewOutcome(review, tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'fix',
      fixes: { T002: ['src/beta.ts writes the token to disk'] },
    });
  });

  it('unmatched Critical goes to the last brief', () => {
    const review = reviewed('fail', [
      { severity: 'critical', text: 'the retry ladder never terminates' },
    ]);
    expect(decideReviewOutcome(review, tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'fix',
      fixes: { T002: ['the retry ladder never terminates'] },
    });
  });

  it('overrides a pass verdict that still carries a Critical finding', () => {
    const review = reviewed('pass', [{ severity: 'critical', text: 'src/alpha.ts drops errors' }]);
    expect(decideReviewOutcome(review, tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'fix',
      fixes: { T001: ['src/alpha.ts drops errors'] },
    });
  });

  it('sends back a Critical written with the colon inside the bold instead of passing it', () => {
    const verdict = parseFinalReview(
      '### Verdict\npass_with_notes\n\n### Findings\n- **Critical:** src/alpha.ts drops errors',
    );

    expect(
      decideReviewOutcome({ reviewStatus: 'written', verdict }, tasks, REVIEW_CYCLE_CAP, 0),
    ).toEqual({ kind: 'fix', fixes: { T001: ['src/alpha.ts drops errors'] } });
  });

  it.each([
    'N/A',
    'n/a',
    'Not applicable',
    'No critical issues found.',
    '0',
    '_None._',
    'Nothing to report.',
    '(none)',
    'None of note.',
    '-',
  ])('passes a pass_with_notes review whose Critical label says %s', (absence) => {
    const verdict = parseFinalReview(
      `### Verdict\npass_with_notes\n\n### Findings\n- **Critical**: ${absence}\n- **Warning**: No validation output was recorded.`,
    );

    expect(
      decideReviewOutcome({ reviewStatus: 'written', verdict }, tasks, REVIEW_CYCLE_CAP, 0),
    ).toEqual({ kind: 'pass' });
  });

  it('fails at the cap, on an unparseable verdict, and on a fail with no Critical', () => {
    const critical = reviewed('fail', [
      { severity: 'critical', text: 'src/alpha.ts drops errors' },
    ]);
    expect(decideReviewOutcome(critical, tasks, REVIEW_CYCLE_CAP, REVIEW_CYCLE_CAP)).toEqual({
      kind: 'fail',
      blocking: 1,
    });
    const unparseable: ReviewOutcomeInput = { reviewStatus: 'unparseable', verdict: null };
    expect(decideReviewOutcome(unparseable, tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'fail',
      blocking: 0,
    });
    expect(decideReviewOutcome(reviewed('fail'), tasks, REVIEW_CYCLE_CAP, 0)).toEqual({
      kind: 'fail',
      blocking: 0,
    });
  });
});

describe('correctionFixes', () => {
  const tasks = [
    makeTask({ id: 'T001', file: 'src/a.ts' }),
    makeTask({ id: 'T002', file: 'src/b.ts' }),
    makeTask({ id: 'T003', file: 'src/c.ts' }),
  ];

  it('puts the correction beside every Critical finding the review attributed', () => {
    expect(
      correctionFixes({ critical: ['src/b.ts leaks'], correction: 'close it', tasks }),
    ).toEqual({ T002: ['src/b.ts leaks', 'Operator correction: close it'] });
  });

  it('also reopens the briefs the correction names beside the ones the review attributed', () => {
    expect(
      correctionFixes({
        critical: ['src/b.ts leaks'],
        correction: 'close it, and src/a.ts must log first',
        tasks,
      }),
    ).toEqual({
      T001: ['Operator correction: close it, and src/a.ts must log first'],
      T002: ['src/b.ts leaks', 'Operator correction: close it, and src/a.ts must log first'],
    });
  });

  it('reopens every brief a lone correction names, else the last brief', () => {
    expect(
      correctionFixes({ critical: [], correction: 'fix src/a.ts and src/c.ts', tasks }),
    ).toEqual({
      T001: ['Operator correction: fix src/a.ts and src/c.ts'],
      T003: ['Operator correction: fix src/a.ts and src/c.ts'],
    });
    expect(correctionFixes({ critical: [], correction: 'add a test', tasks })).toEqual({
      T003: ['Operator correction: add a test'],
    });
    expect(correctionFixes({ critical: [], correction: '', tasks })).toEqual({});
  });
});
